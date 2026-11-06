import json
import os
from datetime import datetime, timedelta
from pathlib import Path

import httpx
from app.gemini import GeminiProviderError
from app.config import Settings

os.environ["DATABASE_URL"] = f"sqlite:///{Path(__file__).parent / 'test.sqlite'}"
os.environ["DEEPSEEK_OFFLINE_MODE"] = "true"

from app.database import Base, Record, SessionLocal, engine
from app.queue import MemoryQueueClient as ReliableMemoryQueueClient, QueueClient
from app.auth.context import ActorContext, actor_scope
from app import app_time
from app.service import create_index_submission, create_task, failure_detail, get_record, list_records, normalize_legacy_index_submissions, now_stamp, queue_article_media_publish_command, queue_index_submission, queue_media_publication_discovery, save_record, sync_auto_publish_task_status
from app import service as service_module
from app import worker as worker_module
from app.worker import Scheduler, TaskExecutor


class MemoryQueueClient:
    def __init__(self):
        self.prefix = "zhixin:queue"
        self.messages = {}

    def enqueue(self, queue, payload):
        self.messages.setdefault(queue, []).append(payload)
        return {"queued": True, "queue": f"{self.prefix}:{queue}"}

    def pop(self, queues, timeout=0):
        for queue in queues:
            if self.messages.get(queue):
                return queue, self.messages[queue].pop(0)
        return None


class FakeSearchIndexService:
    def submit(self, submission):
        return {
            "status": "accepted",
            "submitted": True,
            "submissionMethod": "indexnow",
            "providerMessage": "Provider accepted URL",
            "providerResponse": {"httpStatus": 202},
            "inclusionStatus": "unchecked",
            "verificationLevel": "unavailable",
        }

    def inspect(self, submission):
        return {
            "inclusionStatus": "unchecked",
            "verificationLevel": "unavailable",
            "verificationMethod": "provider_unavailable",
            "providerMessage": "No official inspection API for this provider",
            "evidence": {},
        }

    def check_availability(self, url):
        return {"availabilityStatus": "reachable", "availabilityHttpStatus": 200}


def setup_function():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)


def test_queue_client_reserves_and_acks_json_messages(monkeypatch):
    class ScriptRedis:
        def __init__(self):
            self.lists = {}
            self.hashes = {}
            self.sorted_sets = {}

        def lpush(self, key, message):
            self.lists.setdefault(key, []).insert(0, message)

        def zrangebyscore(self, key, minimum, maximum):
            return []

        def eval(self, script, key_count, *args):
            keys = args[:key_count]
            values = args[key_count:]
            if "zhixin_queue_reserve_v1" in script:
                ready, processing, data, leases = keys
                pending = self.lists.setdefault(ready, [])
                if not pending:
                    return None
                raw = pending.pop()
                self.lists.setdefault(processing, []).insert(0, raw)
                message_id = values[0]
                decoded = json.loads(raw)
                message_id = decoded.get("_queue", {}).get("id") or message_id
                self.hashes.setdefault(data, {})[message_id] = raw
                self.sorted_sets.setdefault(leases, {})[message_id] = float(values[1])
                return [raw, message_id]
            if "zhixin_queue_ack_v1" in script:
                processing, data, leases = keys
                message_id, raw = values
                if self.hashes.setdefault(data, {}).get(message_id) != raw:
                    return 0
                self.lists.setdefault(processing, []).remove(raw)
                self.hashes[data].pop(message_id, None)
                self.sorted_sets.setdefault(leases, {}).pop(message_id, None)
                return 1
            raise AssertionError("Unexpected queue script")

    queue = QueueClient()
    fake = ScriptRedis()
    monkeypatch.setattr(queue, "client", lambda: fake)

    assert queue.enqueue("default", {"taskId": "task-1", "type": "demo"})["queued"] is True
    message = queue.reserve(["default"], timeout=0)
    assert message.payload == {"taskId": "task-1", "type": "demo"}
    assert queue.ack(message) is True
    assert fake.lists["zhixin:queue:default:processing"] == []

def test_create_task_persists_task_before_queueing():
    class ObservingQueue:
        def __init__(self, db):
            self.db = db
            self.task_visible_during_enqueue = False

        def enqueue(self, queue, payload):
            self.task_visible_during_enqueue = self.db.get(Record, payload["taskId"]) is not None
            return {"queued": True, "queue": f"zhixin:queue:{queue}"}

    with SessionLocal() as db:
        queue = ObservingQueue(db)

        task = create_task(db, "ai-generate-article", "Generate article", {"keyword": "AI SEO"}, "ai", queue_backend=queue)

        assert task["status"] == "queued"
        assert queue.task_visible_during_enqueue is True


def test_run_next_acks_reserved_message_only_after_task_succeeds():
    queue = ReliableMemoryQueueClient()
    with SessionLocal() as db:
        submission = create_index_submission(db, {"articleTitle": "Ack task", "url": "https://ack.test"})
        task = create_task(db, "inclusion-check", "Ack successful work", {"submissionId": submission["id"]}, "index", queue_backend=queue)
        executor = TaskExecutor(db, queue, search_index_service=FakeSearchIndexService())

        result = executor.run_next(["index"], timeout=0)

        assert result["status"] == "succeeded"
        assert queue.processing_count("index") == 0
        assert queue.ready_count("index") == 0
        assert get_record(db, "tasks", task["id"])["status"] == "succeeded"


def test_run_next_records_ack_failure_without_marking_business_task_failed():
    class AckFailingQueue(ReliableMemoryQueueClient):
        def ack(self, message):
            return False

    queue = AckFailingQueue(lease_seconds=30)
    with SessionLocal() as db:
        task = create_task(db, "knowledge-refresh", "Refresh knowledge", {}, "knowledge", queue_backend=queue)
        executor = TaskExecutor(db, queue)
        executor.dispatch = lambda queued_task: {"knowledgeId": "knowledge-1"}

        result = executor.run_next(["knowledge"], timeout=0)

        assert result["status"] == "succeeded"
        assert get_record(db, "tasks", task["id"])["status"] == "succeeded"
        logs = list_records(db, "taskLogs")
        assert any(log["event"] == "queue.ack_failed" and log["taskId"] == task["id"] for log in logs)

def test_run_next_nacks_failed_work_and_dead_letters_after_retry_exhaustion():
    queue = ReliableMemoryQueueClient(max_attempts=2)
    with SessionLocal() as db:
        task = create_task(db, "knowledge-fetch-url", "Retry failed work", {
            "knowledgeId": "missing-knowledge",
            "url": "https://failed.test",
        }, "knowledge", queue_backend=queue)
        executor = TaskExecutor(db, queue, url_fetcher=lambda url: (_ for _ in ()).throw(RuntimeError("fetch failed")))

        first = executor.run_next(["knowledge"], timeout=0)
        assert first["status"] == "failed"
        assert queue.ready_count("knowledge") == 1
        assert queue.processing_count("knowledge") == 0

        second = executor.run_next(["knowledge"], timeout=0)
        assert second["status"] == "failed"
        assert queue.ready_count("knowledge") == 0
        assert queue.processing_count("knowledge") == 0
        assert len(queue.dead_letters("knowledge")) == 1
        assert queue.dead_letters("knowledge")[0].payload["taskId"] == task["id"]

def test_worker_prefers_configured_step_provider_for_article_images(monkeypatch):
    settings = Settings(
        database_url="sqlite://",
        gemini_api_key="gemini-key",
        gemini_offline_mode=False,
        article_image_provider="step",
        step_api_key="step-key",
        step_image_model="step-image-edit-2",
    )
    monkeypatch.setattr(worker_module, "get_settings", lambda: settings)

    with SessionLocal() as db:
        executor = TaskExecutor(db, MemoryQueueClient(), llm_generator=lambda context: {})

        assert executor.image_provider == "stepfun"


def test_worker_keeps_deepseek_as_default_article_writer_when_gemini_is_configured(monkeypatch):
    settings = Settings(
        database_url="sqlite://",
        article_text_provider="deepseek",
        deepseek_api_key="deepseek-key",
        deepseek_offline_mode=False,
        gemini_api_key="gemini-key",
        gemini_offline_mode=False,
        article_image_provider="step",
        step_api_key="step-key",
    )
    monkeypatch.setattr(worker_module, "get_settings", lambda: settings)

    with SessionLocal() as db:
        executor = TaskExecutor(db, MemoryQueueClient())

        assert executor.llm_provider == "deepseek"
        assert executor.llm_generator is worker_module.generate_article_with_deepseek


def test_worker_executes_inclusion_check_task_and_updates_logs():
    queue = MemoryQueueClient()
    with SessionLocal() as db:
        submission = create_index_submission(db, {"articleTitle": "A", "url": "https://a.test"})
        task = create_task(db, "inclusion-check", "Check inclusion", {"submissionId": submission["id"]}, "index")

        executor = TaskExecutor(db, queue, search_index_service=FakeSearchIndexService())
        result = executor.run_task(task["id"])

        assert result["status"] == "succeeded"
        updated_submission = [item for item in executor.list_kind("indexSubmissions") if item["id"] == submission["id"]][0]
        assert updated_submission["inclusionStatus"] in ["indexed", "not_indexed", "failed", "unchecked"]
        assert any(log["event"] == "task.succeeded" for log in executor.list_kind("taskLogs"))


def test_worker_does_not_treat_http_reachability_as_search_engine_inclusion():
    queue = MemoryQueueClient()
    with SessionLocal() as db:
        submission = create_index_submission(db, {"articleTitle": "Reachable only", "url": "https://example.com/reachable", "provider": "Baidu"})
        task = create_task(db, "inclusion-check", "Check inclusion", {"submissionId": submission["id"]}, "index")

        result = TaskExecutor(db, queue, search_index_service=FakeSearchIndexService()).run_task(task["id"])

        assert result["status"] == "succeeded"
        updated = get_record(db, "indexSubmissions", submission["id"])
        assert updated["availabilityStatus"] == "reachable"
        assert updated["inclusionStatus"] == "unchecked"
        assert updated["verificationLevel"] == "unavailable"


def test_legacy_http_indexed_records_are_downgraded_to_unverified():
    with SessionLocal() as db:
        legacy = save_record(db, "indexSubmissions", {
            "articleTitle": "Legacy fake indexed",
            "url": "https://example.com/legacy",
            "provider": "Google",
            "status": "submitted",
            "inclusionStatus": "indexed",
        })

        result = normalize_legacy_index_submissions(db)

        updated = get_record(db, "indexSubmissions", legacy["id"])
        assert result["migrated"] == 1
        assert updated["status"] == "unverified"
        assert updated["submitted"] is False
        assert updated["inclusionStatus"] == "unchecked"
        assert updated["legacyInclusionStatus"] == "indexed"
        assert updated["verificationMethod"] == "legacy_http_availability"


def test_legacy_synthetic_submitted_record_without_receipt_is_downgraded():
    with SessionLocal() as db:
        legacy = save_record(db, "indexSubmissions", {
            "articleTitle": "Legacy unchecked submission",
            "url": "https://example.com/legacy-unchecked",
            "provider": "IndexNow",
            "status": "submitted",
            "inclusionStatus": "unchecked",
            "checkedAt": "07/01 10:00",
        })

        result = normalize_legacy_index_submissions(db)

        updated = get_record(db, "indexSubmissions", legacy["id"])
        assert result["migrated"] == 1
        assert updated["status"] == "unverified"
        assert updated["submitted"] is False
        assert updated["legacySubmissionStatus"] == "submitted"


def test_provider_error_is_redacted_before_persisting_submission_or_audit_log():
    class SecretLeakingSearchService(FakeSearchIndexService):
        def submit(self, submission):
            request = httpx.Request("POST", "https://data.zz.baidu.com/urls?site=https%3A%2F%2Fexample.com&token=top-secret-token")
            response = httpx.Response(500, request=request)
            response.raise_for_status()

    queue = MemoryQueueClient()
    with SessionLocal() as db:
        submission = create_index_submission(db, {
            "articleTitle": "Secret-safe failure",
            "url": "https://example.com/secret-safe",
            "provider": "Baidu",
        })
        task = create_task(db, "index-submit", "Submit safely", {"submissionId": submission["id"]}, "index")

        result = TaskExecutor(db, queue, search_index_service=SecretLeakingSearchService()).run_task(task["id"])

        assert result["status"] == "failed"
        updated = get_record(db, "indexSubmissions", submission["id"])
        assert "top-secret-token" not in updated["providerMessage"]
        assert "[REDACTED]" in updated["providerMessage"]
        assert all("top-secret-token" not in str(item) for item in list_records(db, "auditLogs"))


def test_index_submission_can_retry_after_redis_enqueue_failure():
    class RecoveringQueue:
        def __init__(self):
            self.attempts = 0

        def enqueue(self, queue, payload):
            self.attempts += 1
            if self.attempts == 1:
                return {"queued": False, "queue": f"memory:{queue}", "error": "redis unavailable"}
            return {"queued": True, "queue": f"memory:{queue}"}

    queue = RecoveringQueue()
    with SessionLocal() as db:
        first = queue_index_submission(db, {
            "articleTitle": "Retry enqueue",
            "url": "https://example.com/retry-enqueue",
            "provider": "IndexNow",
        }, queue_backend=queue)
        second = queue_index_submission(db, {"submissionId": first["id"]}, queue_backend=queue)

        assert first["queued"] is False
        assert second["queued"] is True
        assert second["taskId"] != first["taskId"]
        assert get_record(db, "tasks", first["taskId"])["status"] == "failed"


def test_worker_executes_index_submit_task_and_creates_submission():
    queue = MemoryQueueClient()
    with SessionLocal() as db:
        article = save_record(db, "articles", {
            "id": "article-index-submit-1",
            "title": "Index submit article",
            "publishedUrl": "https://example.com/articles/index-submit",
            "status": "published",
        })
        task = create_task(db, "index-submit", "Submit index", {
            "articleId": article["id"],
            "articleTitle": article["title"],
            "url": article["publishedUrl"],
            "provider": "IndexNow",
            "source": "batch-operation",
            "sourceType": "article",
            "sourceId": article["id"],
        }, "index")

        result = TaskExecutor(db, queue, search_index_service=FakeSearchIndexService()).run_task(task["id"])

        assert result["status"] == "succeeded"
        submissions = list_records(db, "indexSubmissions")
        assert len(submissions) == 1
        assert submissions[0]["articleId"] == article["id"]
        assert submissions[0]["url"] == article["publishedUrl"]
        assert submissions[0]["provider"] == "IndexNow"
        assert submissions[0]["status"] == "accepted"
        assert submissions[0]["submitted"] is True
        assert submissions[0]["providerResponse"] == {"httpStatus": 202}
        assert result["result"]["indexSubmissionId"] == submissions[0]["id"]


def test_create_index_submission_preserves_dataforseo_observation_provider():
    with SessionLocal() as db:
        submission = create_index_submission(db, {
            "articleTitle": "Observed media URL",
            "provider": "DataForSEO",
            "sourceType": "media",
            "url": "https://zhuanlan.zhihu.com/p/123456789",
        })

        assert submission["provider"] == "DataForSEO"
        assert submission["sourceType"] == "media"


def test_worker_executes_knowledge_url_task_with_fetcher():
    queue = MemoryQueueClient()
    with SessionLocal() as db:
        item = save_record(db, "knowledgeItems", {
            "id": "knowledge-url-1",
            "title": "Remote Guide",
            "source": "web",
            "url": "https://example.com/guide",
            "status": "queued",
        })
        task = create_task(db, "knowledge-fetch-url", "Fetch URL", {"knowledgeId": item["id"], "url": item["url"]}, "knowledge")

        executor = TaskExecutor(db, queue, url_fetcher=lambda url: "SEO guide paragraph.\n\nGEO guide paragraph.")
        result = executor.run_task(task["id"])

        assert result["status"] == "succeeded"
        knowledge = executor.get_kind("knowledgeItems", item["id"])
        assert knowledge["status"] == "completed"
        assert knowledge["chunkCount"] >= 1
        assert len(executor.list_kind("knowledgeVectors")) == knowledge["vectorCount"]
        notifications = list_records(db, "notifications")
        assert notifications[0]["level"] == "success"
        assert notifications[0]["target"]["knowledgeId"] == item["id"]
        assert notifications[0]["href"] == f"/ai-writer/knowledge?knowledgeId={item['id']}"


def test_worker_executes_knowledge_upload_parse_task_from_saved_file(tmp_path):
    queue = MemoryQueueClient()
    upload_file = tmp_path / "queued-notes.txt"
    upload_file.write_text("Queued SEO paragraph.\n\nQueued GEO paragraph.", encoding="utf-8")

    with SessionLocal() as db:
        item = save_record(db, "knowledgeItems", {
            "id": "knowledge-upload-1",
            "title": "Queued Notes",
            "source": "upload",
            "filename": "queued-notes.txt",
            "contentType": "text/plain",
            "path": str(upload_file),
            "status": "queued",
            "chunkCount": 0,
            "vectorCount": 0,
        })
        task = create_task(db, "knowledge-upload-parse", "Parse upload", {
            "knowledgeId": item["id"],
            "path": str(upload_file),
            "contentType": "text/plain",
        }, "knowledge")

        result = TaskExecutor(db, queue).run_task(task["id"])

        assert result["status"] == "succeeded"
        knowledge = executor_knowledge = TaskExecutor(db, queue).get_kind("knowledgeItems", item["id"])
        assert knowledge["status"] == "completed"
        assert "Queued SEO paragraph." in knowledge["content"]
        assert knowledge["chunkCount"] >= 1
        assert len(list_records(db, "knowledgeChunks")) == knowledge["chunkCount"]
        assert len(list_records(db, "knowledgeVectors")) == knowledge["vectorCount"]
        assert any(log["event"] == "knowledge.parsed" for log in list_records(db, "taskLogs"))


def test_scheduler_enqueues_scheduled_refresh_and_index_retry_tasks():
    queue = MemoryQueueClient()
    with SessionLocal() as db:
        save_record(db, "knowledgeItems", {
            "id": "knowledge-refresh-1",
            "title": "Scheduled URL",
            "source": "web",
            "url": "https://example.com/refresh",
            "refreshMode": "scheduled",
            "status": "completed",
        })
        create_index_submission(db, {
            "id": "index-retry-1",
            "articleTitle": "Retry URL",
            "url": "https://example.com/retry",
            "status": "accepted",
            "submitted": True,
            "inclusionStatus": "not_indexed",
        })

        result = Scheduler(db, queue).enqueue_due_jobs()

        assert result["knowledgeRefresh"] == 1
        assert result["indexRetry"] == 1
        task_types = [message["type"] for messages in queue.messages.values() for message in messages]
        assert "knowledge-fetch-url" in task_types
        assert "inclusion-check" in task_types


def test_scheduler_does_not_duplicate_active_refresh_or_index_retry_tasks():
    queue = MemoryQueueClient()
    with SessionLocal() as db:
        save_record(db, "knowledgeItems", {
            "id": "knowledge-scheduled-dedup",
            "title": "Scheduled source",
            "source": "web",
            "refreshMode": "scheduled",
            "url": "https://example.com/source",
        })
        create_index_submission(db, {
            "id": "index-retry-dedup",
            "articleTitle": "Retry me",
            "url": "https://example.com/retry",
            "status": "accepted",
            "submitted": True,
            "inclusionStatus": "unchecked",
        })

        first = Scheduler(db, queue).enqueue_due_jobs()
        second = Scheduler(db, queue).enqueue_due_jobs()

        assert first["knowledgeRefresh"] == 1
        assert first["indexRetry"] == 1
        assert second["knowledgeRefresh"] == 0
        assert second["indexRetry"] == 0
        assert len(queue.messages["knowledge"]) == 1
        assert len(queue.messages["index"]) == 1


def test_scheduler_does_not_check_inclusion_before_provider_submission_finishes():
    queue = MemoryQueueClient()
    with SessionLocal() as db:
        create_index_submission(db, {
            "id": "index-pending-provider",
            "articleTitle": "Pending provider",
            "url": "https://example.com/pending",
            "status": "pending",
            "submitted": False,
            "inclusionStatus": "unchecked",
        })

        result = Scheduler(db, queue).enqueue_due_jobs()

        assert result["indexRetry"] == 0
        assert queue.messages.get("index", []) == []


def test_scheduler_does_not_repeat_recent_inclusion_verification():
    queue = MemoryQueueClient()
    with SessionLocal() as db:
        create_index_submission(db, {
            "id": "index-recently-checked",
            "articleTitle": "Recently checked",
            "url": "https://example.com/recent",
            "status": "accepted",
            "submitted": True,
            "inclusionStatus": "unchecked",
            "checkedAt": app_time.now_stamp(),
        })

        result = Scheduler(db, queue).enqueue_due_jobs()

        assert result["indexRetry"] == 0
        assert queue.messages.get("index", []) == []


def test_worker_executes_seo_collection_with_provider_results():
    class FakeSeoProvider:
        def collect(self, task_type, payload):
            if task_type == "keyword-discover":
                return {"keywords": [{"word": "AI SEO tools", "searchVolume": 1200}], "provider": "fake-seo"}
            if task_type == "serp-collect":
                return {"results": [{"title": "Top AI SEO", "url": "https://example.com/top"}], "provider": "fake-seo"}
            if task_type == "geo-collect":
                return {"questions": [{"question": "Which AI SEO tool is cited?", "brandMentioned": True}], "provider": "fake-seo"}
            if task_type == "ranking-check":
                return {"rank": 3, "provider": "fake-seo"}
            return {}

    queue = MemoryQueueClient()
    with SessionLocal() as db:
        record = save_record(db, "keywords", {"id": "keyword-provider-1", "seed": "AI SEO", "status": "queued"})
        task = create_task(db, "keyword-discover", "Discover keywords", {"recordId": record["id"], "seed": "AI SEO"}, "seo")

        executor = TaskExecutor(db, queue, seo_provider=FakeSeoProvider())
        result = executor.run_task(task["id"])

        assert result["status"] == "succeeded"
        updated = executor.get_kind("keywords", record["id"])
        assert updated["status"] == "collected"
        assert updated["providerResult"]["keywords"][0]["word"] == "AI SEO tools"


def test_worker_uses_provider_config_id_for_seo_collection_without_leaking_api_key():
    calls = []

    class ConfiguredSeoProvider:
        def __init__(self, base_url, api_key):
            calls.append({"baseUrl": base_url, "apiKey": api_key})

        def collect(self, task_type, payload):
            return {"provider": "configured-seo", "keywords": [{"word": "Configured AI SEO", "searchVolume": 700}]}

    queue = MemoryQueueClient()
    with SessionLocal() as db:
        config = save_record(db, "seoProviderConfigs", {
            "id": "seo-provider-config-1",
            "name": "Configured Provider",
            "provider": "configured-seo",
            "baseUrl": "https://seo-provider.test",
            "apiKey": "placeholder-provider-key",
            "capabilities": ["keyword-discover"],
            "enabled": True,
            "status": "connected",
        })
        task = create_task(db, "keyword-discover", "Discover with configured provider", {
            "seed": "AI SEO",
            "providerConfigId": config["id"],
        }, "seo")

        executor = TaskExecutor(db, queue, provider_factory=lambda base_url, api_key: ConfiguredSeoProvider(base_url, api_key))
        result = executor.run_task(task["id"])

        assert result["status"] == "succeeded"
        assert calls == [{"baseUrl": "https://seo-provider.test", "apiKey": "placeholder-provider-key"}]
        raw = list_records(db, "seoProviderResults")[0]
        assert raw["providerConfigId"] == config["id"]
        assert raw["provider"] == "configured-seo"
        assert raw["requestPayload"]["providerConfigId"] == config["id"]
        assert "placeholder-provider-key" not in str(raw)
        assert any(item["word"] == "Configured AI SEO" for item in list_records(db, "keywords"))


def test_worker_normalizes_seo_provider_results_into_business_records():
    class RichSeoProvider:
        def collect(self, task_type, payload):
            if task_type == "keyword-discover":
                return {
                    "provider": "rich-seo",
                    "keywords": [
                        {"word": "AI SEO automation", "searchVolume": 980, "difficulty": 52, "trend": "up", "relatedWords": ["GEO"], "status": "suggested"}
                    ],
                }
            if task_type == "serp-collect":
                return {
                    "provider": "rich-seo",
                    "keyword": payload["keyword"],
                    "searchEngine": "Google",
                    "region": "US",
                    "device": "desktop",
                    "topResults": [{"position": 1, "title": "AI SEO Guide", "url": "https://example.com/guide", "domain": "example.com", "snippet": "Guide"}],
                    "relatedQuestions": ["How does AI SEO work?"],
                    "relatedKeywords": ["AI search"],
                    "contentBrief": "Write a practical guide.",
                }
            if task_type == "geo-collect":
                return {
                    "provider": "rich-seo",
                    "questions": [
                        {
                            "keyword": "AI SEO",
                            "question": "Which brand is cited?",
                            "platform": "DeepSeek",
                            "sourceUrl": "https://example.com/source",
                            "sourceMedia": "example.com",
                            "answerExcerpt": "Zhixin AI is cited.",
                            "brandMention": True,
                            "competitorMention": False,
                        }
                    ],
                }
            if task_type == "ranking-check":
                return {
                    "provider": "rich-seo",
                    "rankings": [
                        {"keyword": payload["keyword"], "url": payload["url"], "engine": "Google", "region": "US", "position": 4, "previousPosition": 9, "status": "indexed"}
                    ],
                }
            raise AssertionError(task_type)

    queue = MemoryQueueClient()
    with SessionLocal() as db:
        tasks = [
            create_task(db, "keyword-discover", "Discover keywords", {"seed": "AI SEO"}, "seo"),
            create_task(db, "serp-collect", "Collect SERP", {"keyword": "AI SEO"}, "seo"),
            create_task(db, "geo-collect", "Collect GEO", {"keyword": "AI SEO", "brand": "Zhixin AI"}, "seo"),
            create_task(db, "ranking-check", "Check ranking", {"keyword": "AI SEO", "url": "https://example.com/guide"}, "seo"),
        ]

        executor = TaskExecutor(db, queue, seo_provider=RichSeoProvider())
        for task in tasks:
            assert executor.run_task(task["id"])["status"] == "succeeded"

        keywords = list_records(db, "keywords")
        assert any(item["word"] == "AI SEO automation" and item["provider"] == "rich-seo" for item in keywords)

        serp_records = list_records(db, "serpAnalyses")
        assert any(item["keyword"] == "AI SEO" and item["topResults"][0]["title"] == "AI SEO Guide" for item in serp_records)

        geo_questions = list_records(db, "geoQuestions")
        assert any(item["question"] == "Which brand is cited?" and item["brandMention"] is True for item in geo_questions)

        rankings = list_records(db, "rankingEntries")
        assert any(item["position"] == 4 and item["change"] == 5 for item in rankings)

        raw_results = list_records(db, "seoProviderResults")
        assert {item["taskType"] for item in raw_results} == {"keyword-discover", "serp-collect", "geo-collect", "ranking-check"}


def test_worker_logs_seo_provider_failures():
    class BrokenSeoProvider:
        def collect(self, task_type, payload):
            raise RuntimeError("seo provider unavailable")

    queue = MemoryQueueClient()
    with SessionLocal() as db:
        task = create_task(db, "serp-collect", "Collect broken SERP", {"keyword": "AI SEO"}, "seo")

        result = TaskExecutor(db, queue, seo_provider=BrokenSeoProvider()).run_task(task["id"])

        assert result["status"] == "failed"
        assert "seo provider unavailable" in result["errorMessage"]
        assert any(log["event"] == "task.failed" and "seo provider unavailable" in log["message"] for log in list_records(db, "taskLogs"))
        assert any(notification["level"] == "error" and notification["target"]["taskId"] == task["id"] for notification in list_records(db, "notifications"))
        raw_results = list_records(db, "seoProviderResults")
        assert len(raw_results) == 1
        assert raw_results[0]["taskId"] == task["id"]
        assert raw_results[0]["taskType"] == "serp-collect"
        assert raw_results[0]["status"] == "failed"
        assert raw_results[0]["requestPayload"]["keyword"] == "AI SEO"
        assert "seo provider unavailable" in raw_results[0]["response"]["errorMessage"]
        detail = failure_detail(db, task["id"])
        assert detail["providerResults"][0]["id"] == raw_results[0]["id"]


def test_worker_executes_ai_generation_without_creating_duplicate_generation_task():
    queue = MemoryQueueClient()
    with SessionLocal() as db:
        rule = save_record(db, "generationRules", {"id": "rule-ai-1", "name": "AI Rule", "content": "Use context."})
        knowledge = save_record(db, "knowledgeItems", {"id": "knowledge-ai-1", "title": "Facts", "content": "Brand facts."})
        asset = save_record(db, "assets", {"id": "asset-ai-1", "filename": "hero.png", "altText": "Hero"})
        brand = save_record(db, "brandProfiles", {"id": "brand-ai-1", "name": "Zhixin AI"})
        competitor = save_record(db, "competitorProfiles", {"id": "competitor-ai-1", "name": "Kuaijing SEO"})
        task = create_task(db, "ai-generate-article", "Generate article", {
            "keyword": "Queued AI SEO",
            "writerContext": {"audience": "operators"},
            "ruleId": rule["id"],
            "knowledgeIds": [knowledge["id"]],
            "assetIds": [asset["id"]],
        }, "ai")

        executor = TaskExecutor(
            db,
            queue,
            llm_generator=lambda context: {
                "title": f"{context['keyword']} generated",
                "summary": "Generated summary",
                "metaDescription": "Generated meta",
                "contentMarkdown": "# Generated\n\nQueued AI SEO content.",
                "keywords": [context["keyword"]],
                "tags": ["queued"],
            },
        )
        result = executor.run_task(task["id"])

        assert result["status"] == "succeeded"
        articles = executor.list_kind("articles")
        assert len(articles) == 1
        assert articles[0]["source"] == "deepseek_ai"
        assert articles[0]["writerContext"]["rule"]["id"] == rule["id"]
        assert articles[0]["writerContext"]["brandProfiles"][0]["id"] == brand["id"]
        assert articles[0]["writerContext"]["competitorProfiles"][0]["id"] == competitor["id"]
        tasks = list_records(db, "tasks")
        assert [item["type"] for item in tasks].count("ai-generate-article") == 1
        llm_requests = list_records(db, "llmRequests")
        assert len(llm_requests) == 1
        assert llm_requests[0]["taskId"] == task["id"]
        assert llm_requests[0]["articleId"] == articles[0]["id"]
        assert llm_requests[0]["contextSummary"]["ruleId"] == rule["id"]
        assert llm_requests[0]["contextSummary"]["knowledgeItemIds"] == [knowledge["id"]]
        assert llm_requests[0]["contextSummary"]["assetIds"] == [asset["id"]]
        assert llm_requests[0]["contextSummary"]["brandProfileIds"] == [brand["id"]]
        assert llm_requests[0]["contextSummary"]["competitorProfileIds"] == [competitor["id"]]
        assert "Queued AI SEO content." in llm_requests[0]["responseSummary"]["contentPreview"]
        assert "Queued AI SEO content." not in llm_requests[0]["normalizedResponseSummary"]["contentPreview"]
        assert "Queued AI SEO" in llm_requests[0]["normalizedResponseSummary"]["contentPreview"]


def test_worker_generates_images_saves_assets_and_assembles_article(tmp_path, monkeypatch):
    monkeypatch.setenv("UPLOAD_DIR", str(tmp_path))
    queue = MemoryQueueClient()
    with SessionLocal() as db:
        task = create_task(db, "ai-generate-article", "Generate illustrated article", {
            "keyword": "AI SEO 图文创作",
            "generateImages": True,
            "imageStrategy": "cover-and-inline",
            "maxInlineImages": 2,
        }, "ai")
        article_output = {
            "title": "AI SEO 图文创作指南",
            "summary": "图文创作摘要",
            "metaDescription": "AI SEO 图文创作完整指南",
            "keywords": ["AI SEO"],
            "tags": ["图文"],
            "sections": [
                {"id": "intro", "title": "创作基础", "content": "清晰内容。" * 60},
                {"id": "workflow", "title": "实施流程", "content": "稳定流程。" * 60},
            ],
            "imageBriefs": [
                {"purpose": "cover", "prompt": "专业封面", "altText": "AI SEO 封面", "aspectRatio": "16:9"},
                {"purpose": "inline", "sectionId": "workflow", "prompt": "流程图", "altText": "AI SEO 流程", "aspectRatio": "4:3"},
            ],
        }

        result = TaskExecutor(
            db,
            queue,
            llm_generator=lambda context: article_output,
            image_generator=lambda brief: {"data": b"image-bytes", "mimeType": "image/png", "model": "gemini-3.1-flash-image"},
        ).run_task(task["id"])

        assert result["status"] == "succeeded"
        assert result["result"]["imageSucceeded"] == 3
        assert result["result"]["imageFailed"] == 0
        assert result["result"]["stage"] == "complete"
        assert result["stage"] == "complete"
        article = get_record(db, "articles", result["result"]["articleId"])
        assert article["imageGenerationStatus"] == "completed"
        assert article["coverImage"]["purpose"] == "cover"
        assert "![AI SEO 流程]" in article["contentMarkdown"]
        assert [block["type"] for block in article["contentBlocks"]] == ["title", "section", "image", "section", "image"]
        assert article["contentBlocks"][2]["sectionId"] == "intro"
        assert article["contentBlocks"][4]["sectionId"] == "workflow"
        assets = list_records(db, "assets")
        assert len(assets) == 3
        assert all(asset["source"] == "ai" and Path(asset["path"]).exists() for asset in assets)


def test_worker_keeps_article_and_successful_images_when_one_image_fails(tmp_path, monkeypatch):
    monkeypatch.setenv("UPLOAD_DIR", str(tmp_path))
    calls = 0

    def generate_image(brief):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError("image quota exceeded")
        return {"data": b"cover-bytes", "mimeType": "image/png", "model": "gemini-3.1-flash-image"}

    queue = MemoryQueueClient()
    with SessionLocal() as db:
        task = create_task(db, "ai-generate-article", "Generate partial illustrated article", {
            "keyword": "部分配图",
            "generateImages": True,
            "imageStrategy": "cover-and-inline",
        }, "ai")
        output = {
            "title": "部分配图文章",
            "summary": "部分配图摘要",
            "metaDescription": "部分配图测试",
            "sections": [{"id": "body", "title": "正文", "content": "可读正文。" * 80}],
            "imageBriefs": [
                {"purpose": "cover", "prompt": "封面", "altText": "封面"},
                {"purpose": "inline", "sectionId": "body", "prompt": "插图", "altText": "插图"},
            ],
        }

        result = TaskExecutor(db, queue, llm_generator=lambda context: output, image_generator=generate_image).run_task(task["id"])

        assert result["status"] == "succeeded"
        assert result["result"]["imageSucceeded"] == 1
        assert result["result"]["imageFailed"] == 1
        article = get_record(db, "articles", result["result"]["articleId"])
        assert article["imageGenerationStatus"] == "partial"
        assert article["status"] == "review_required"
        assert article["imageErrors"][0]["code"] == "IMAGE_GENERATION_FAILED"


def test_worker_keeps_article_when_image_provider_is_not_configured(monkeypatch):
    monkeypatch.setattr(worker_module, "get_settings", lambda: Settings(
        database_url="sqlite://",
        gemini_api_key="",
        article_image_provider="step",
        step_api_key="",
    ))
    queue = MemoryQueueClient()
    with SessionLocal() as db:
        task = create_task(db, "ai-generate-article", "Generate without image quota", {
            "keyword": "图片额度未开通",
            "generateImages": True,
            "imageStrategy": "cover",
        }, "ai")
        output = {
            "title": "图片额度未开通时的文章",
            "summary": "文章仍应保存",
            "metaDescription": "配图失败不会丢失正文",
            "sections": [{"id": "body", "title": "正文", "content": "正文内容。" * 80}],
            "imageBriefs": [{"purpose": "cover", "prompt": "封面", "altText": "封面"}],
        }

        result = TaskExecutor(db, queue, llm_generator=lambda context: output, image_generator=None).run_task(task["id"])

        assert result["status"] == "succeeded"
        article = get_record(db, "articles", result["result"]["articleId"])
        assert article["status"] == "review_required"
        assert article["imageGenerationStatus"] == "failed"
        assert article["imageErrors"][0]["code"] == "IMAGE_PROVIDER_NOT_CONFIGURED"


def test_worker_preserves_provider_error_code_for_image_failure():
    queue = MemoryQueueClient()
    with SessionLocal() as db:
        task = create_task(db, "ai-generate-article", "Generate rate-limited image", {
            "keyword": "图片限流",
            "generateImages": True,
            "imageStrategy": "cover",
        }, "ai")
        output = {
            "title": "图片限流文章",
            "summary": "文章仍保存",
            "metaDescription": "图片错误应可操作",
            "sections": [{"id": "body", "title": "正文", "content": "正文内容。" * 80}],
            "imageBriefs": [{"purpose": "cover", "prompt": "封面", "altText": "封面"}],
        }

        result = TaskExecutor(
            db,
            queue,
            llm_generator=lambda context: output,
            image_generator=lambda brief: (_ for _ in ()).throw(GeminiProviderError("GEMINI_RATE_LIMITED", "图片模型额度不足")),
        ).run_task(task["id"])

        article = get_record(db, "articles", result["result"]["articleId"])
        assert article["imageErrors"][0]["code"] == "GEMINI_RATE_LIMITED"


def test_worker_applies_quality_status_when_images_are_disabled():
    queue = MemoryQueueClient()
    with SessionLocal() as db:
        task = create_task(db, "ai-generate-article", "Generate malformed text article", {
            "keyword": "短文",
            "generateImages": False,
        }, "ai")

        result = TaskExecutor(db, queue, llm_generator=lambda context: {
            "title": "短文",
            "summary": "过短",
            "metaDescription": "过短",
            "contentMarkdown": "只有一句话。",
        }).run_task(task["id"])

        article = get_record(db, "articles", result["result"]["articleId"])
        assert article["status"] == "review_required"


def test_worker_ai_generation_auto_retrieves_relevant_knowledge_chunks():
    queue = MemoryQueueClient()
    captured_contexts = []
    with SessionLocal() as db:
        knowledge = save_record(db, "knowledgeItems", {
            "id": "knowledge-auto-search-1",
            "title": "Publishing Knowledge",
            "tags": ["seo"],
            "status": "completed",
        })
        save_record(db, "knowledgeChunks", {
            "id": "knowledge-auto-search-1-chunk-1",
            "knowledgeId": knowledge["id"],
            "index": 0,
            "content": "WordPress publishing automation sends SEO articles to integrated sites.",
        })
        task = create_task(db, "ai-generate-article", "Generate with retrieved knowledge", {
            "keyword": "WordPress publishing automation",
        }, "ai")

        def generate(context):
            captured_contexts.append(context)
            return {
                "title": "Retrieved draft",
                "summary": "Generated with retrieved chunks",
                "metaDescription": "Generated meta",
                "contentMarkdown": "# Retrieved\n\nUses knowledge chunks.",
                "keywords": [context["keyword"]],
                "tags": ["retrieved"],
            }

        result = TaskExecutor(db, queue, llm_generator=generate).run_task(task["id"])

        assert result["status"] == "succeeded"
        assert captured_contexts[0]["knowledgeChunks"][0]["chunkId"] == "knowledge-auto-search-1-chunk-1"
        assert "WordPress publishing automation" in captured_contexts[0]["knowledgeChunks"][0]["content"]
        article = list_records(db, "articles")[0]
        assert article["writerContext"]["knowledgeChunks"][0]["knowledgeId"] == knowledge["id"]
        llm_request = list_records(db, "llmRequests")[0]
        prompt_text = "\n".join(message["content"] for message in llm_request["requestPayload"]["messages"])
        assert "WordPress publishing automation sends SEO articles" in prompt_text


def test_writer_context_resolves_nested_selected_resource_ids_from_web_client():
    queue = MemoryQueueClient()
    captured = []
    with SessionLocal() as db:
        selected_knowledge = save_record(db, "knowledgeItems", {"id": "knowledge-selected", "title": "Selected knowledge", "content": "Selected facts"})
        save_record(db, "knowledgeItems", {"id": "knowledge-other", "title": "Other knowledge", "content": "Other facts"})
        selected_asset = save_record(db, "assets", {"id": "asset-selected", "filename": "selected.png", "type": "cover"})
        save_record(db, "assets", {"id": "asset-other", "filename": "other.png", "type": "cover"})
        selected_brand = save_record(db, "brandProfiles", {"id": "brand-selected", "name": "Selected brand"})
        save_record(db, "brandProfiles", {"id": "brand-other", "name": "Other brand"})
        selected_competitor = save_record(db, "competitorProfiles", {"id": "competitor-selected", "name": "Selected competitor"})
        save_record(db, "competitorProfiles", {"id": "competitor-other", "name": "Other competitor"})
        task = create_task(db, "ai-generate-article", "Generate selected context", {
            "keyword": "Selected context",
            "writerContext": {
                "knowledgeItemIds": [selected_knowledge["id"]],
                "assetIds": [selected_asset["id"]],
                "brandProfileIds": [selected_brand["id"]],
                "competitorProfileIds": [selected_competitor["id"]],
            },
        }, "ai")

        result = TaskExecutor(db, queue, llm_generator=lambda context: captured.append(context) or {
            "title": "Selected context article",
            "summary": "Summary",
            "metaDescription": "Meta",
            "contentMarkdown": "# Selected context\n\nContent",
        }).run_task(task["id"])

        assert result["status"] == "succeeded"
        assert [item["id"] for item in captured[0]["knowledgeItems"]] == [selected_knowledge["id"]]
        assert [item["id"] for item in captured[0]["assets"]] == [selected_asset["id"]]
        assert [item["id"] for item in captured[0]["brandProfiles"]] == [selected_brand["id"]]
        assert [item["id"] for item in captured[0]["competitorProfiles"]] == [selected_competitor["id"]]


def test_worker_records_failed_llm_request_when_ai_generation_raises():
    queue = MemoryQueueClient()
    with SessionLocal() as db:
        rule = save_record(db, "generationRules", {"id": "rule-failed-ai-1", "name": "Failed AI Rule", "content": "Use context."})
        task = create_task(db, "ai-generate-article", "Generate broken article", {
            "keyword": "Broken AI SEO",
            "ruleId": rule["id"],
        }, "ai")

        result = TaskExecutor(
            db,
            queue,
            llm_generator=lambda context: (_ for _ in ()).throw(RuntimeError("deepseek timeout")),
        ).run_task(task["id"])

        assert result["status"] == "failed"
        assert "deepseek timeout" in result["errorMessage"]
        llm_requests = list_records(db, "llmRequests")
        assert len(llm_requests) == 1
        assert llm_requests[0]["status"] == "failed"
        assert llm_requests[0]["taskId"] == task["id"]
        assert llm_requests[0]["articleId"] == ""
        assert llm_requests[0]["contextSummary"]["ruleId"] == rule["id"]
        assert "deepseek timeout" in llm_requests[0]["errorMessage"]


def test_worker_executes_media_backlink_public_url_task_without_index_submission():
    queue = MemoryQueueClient()
    with SessionLocal() as db:
        order = save_record(db, "mediaOrders", {
            "id": "media-order-1",
            "articleTitle": "Media Backlink Article",
            "resourceName": "Media",
            "status": "pending",
            "backlinkStatus": "pending",
            "backlinkUrl": "https://www.zhihu.com/p/123456789",
        })
        task = create_task(db, "media-backlink-index", "Publish media backlink", {"orderId": order["id"], "provider": "Google"}, "media")

        result = TaskExecutor(db, queue).run_task(task["id"])

        assert result["status"] == "succeeded"
        updated = [item for item in list_records(db, "mediaOrders") if item["id"] == order["id"]][0]
        assert updated["status"] == "succeeded"
        assert updated["backlinkUrl"] == "https://www.zhihu.com/p/123456789"
        assert list_records(db, "indexSubmissions") == []


def test_worker_keeps_webhook_publication_without_url_pending_for_verification(monkeypatch):
    class Response:
        content = b'{"status":"submitted"}'

        def raise_for_status(self):
            return None

        def json(self):
            return {"status": "submitted"}

    monkeypatch.setattr(httpx, "post", lambda *args, **kwargs: Response())
    queue = MemoryQueueClient()
    with SessionLocal() as db:
        resource = save_record(db, "mediaResources", {
            "id": "media-resource-url-missing",
            "name": "Webhook media",
            "webhookUrl": "https://publisher.test/webhook",
        })
        order = save_record(db, "mediaOrders", {
            "id": "media-order-url-missing",
            "articleTitle": "Pending public URL",
            "resourceId": resource["id"],
            "status": "pending",
            "backlinkStatus": "pending",
            "backlinkUrl": "",
        })
        task = create_task(db, "media-backlink-index", "Publish without public URL", {
            "orderId": order["id"],
            "submitIndex": True,
        }, "media")

        result = TaskExecutor(db, queue).run_task(task["id"])

        assert result["status"] == "succeeded"
        updated = get_record(db, "mediaOrders", order["id"])
        assert updated["status"] == "review_required"
        assert updated["reviewStatus"] == "pending_public_visibility"
        assert updated["backlinkStatus"] == "blocked"
        assert updated["backlinkUrl"] == ""
        assert updated["errorCode"] == "PUBLICATION_URL_MISSING"
        assert list_records(db, "indexSubmissions") == []


def test_worker_rejects_invalid_webhook_publication_url(monkeypatch):
    class Response:
        content = b'{"url":"not-a-public-url"}'

        def raise_for_status(self):
            return None

        def json(self):
            return {"url": "not-a-public-url", "status": "submitted"}

    monkeypatch.setattr(httpx, "post", lambda *args, **kwargs: Response())
    with SessionLocal() as db:
        resource = save_record(db, "mediaResources", {
            "id": "media-resource-url-invalid",
            "name": "Webhook media",
            "webhookUrl": "https://publisher.test/webhook",
        })
        order = save_record(db, "mediaOrders", {
            "id": "media-order-url-invalid",
            "articleTitle": "Invalid public URL",
            "resourceId": resource["id"],
            "status": "pending",
            "backlinkUrl": "",
        })
        task = create_task(db, "media-backlink-index", "Publish invalid URL", {"orderId": order["id"]}, "media")

        result = TaskExecutor(db, MemoryQueueClient()).run_task(task["id"])

        assert result["status"] == "succeeded"
        updated = get_record(db, "mediaOrders", order["id"])
        assert updated["status"] == "review_required"
        assert updated["backlinkUrl"] == ""
        assert updated["errorCode"] == "PUBLICATION_URL_INVALID"


def test_worker_fallback_mode_never_fabricates_media_publication_url(monkeypatch):
    settings = Settings(database_url="sqlite://", media_publish_fallback_mock=True)
    monkeypatch.setattr("app.service.get_settings", lambda: settings)
    with SessionLocal() as db:
        order = save_record(db, "mediaOrders", {
            "id": "media-order-fallback-no-url",
            "articleTitle": "Fallback must stay truthful",
            "status": "pending",
            "backlinkUrl": "",
        })
        task = create_task(db, "media-backlink-index", "Fallback without URL", {
            "orderId": order["id"],
            "submitIndex": True,
        }, "media")

        result = TaskExecutor(db, MemoryQueueClient()).run_task(task["id"])

        assert result["status"] == "succeeded"
        updated = get_record(db, "mediaOrders", order["id"])
        assert updated["status"] == "review_required"
        assert updated["backlinkUrl"] == ""
        assert updated["errorCode"] == "PUBLICATION_URL_MISSING"
        assert list_records(db, "indexSubmissions") == []

def test_worker_rechecks_reviewed_media_order_and_updates_public_url_without_index_submission():
    queue = MemoryQueueClient()
    with SessionLocal() as db:
        article = save_record(db, "articles", {
            "id": "article-netease-review-1",
            "title": "智心AI网易号公开复验",
            "status": "ready",
            "publishStatus": "submitted_for_review",
            "indexStatus": "not_submitted",
            "contentMarkdown": "这是一篇用于公开复验的网易号文章正文，确认页面公开后才能提交索引。",
        })
        order = save_record(db, "mediaOrders", {
            "id": "media-order-review-1",
            "articleId": article["id"],
            "articleTitle": article["title"],
            "resourceName": "网易号账号",
            "status": "review_required",
            "backlinkStatus": "blocked",
            "backlinkUrl": "",
            "reviewUrl": "https://www.163.com/dy/article/REVIEW_OK.html",
            "platformStatus": "submitted_for_review",
            "reviewStatus": "pending_public_visibility",
        })
        task = create_task(db, "media-publication-recheck", "Recheck NetEase publication", {
            "orderId": order["id"],
            "provider": "Google",
            "checkImmediately": True,
        }, "media")

        result = TaskExecutor(
            db,
            queue,
            url_fetcher=lambda url: "网易号公开页 智心AI网易号公开复验 这是一篇用于公开复验的网易号文章正文",
            search_index_service=FakeSearchIndexService(),
        ).run_task(task["id"])

        assert result["status"] == "succeeded"
        assert result["result"]["verified"] is True
        updated_order = [item for item in list_records(db, "mediaOrders") if item["id"] == order["id"]][0]
        assert updated_order["status"] == "succeeded"
        assert updated_order["backlinkStatus"] == "generated"
        assert updated_order["backlinkUrl"] == "https://www.163.com/dy/article/REVIEW_OK.html"
        updated_article = [item for item in list_records(db, "articles") if item["id"] == article["id"]][0]
        assert updated_article["status"] == "published"
        assert updated_article["publishStatus"] == "published"
        assert updated_article["indexStatus"] == "not_submitted"
        assert list_records(db, "indexSubmissions") == []


def test_worker_recheck_keeps_media_order_pending_when_public_page_does_not_match():
    queue = MemoryQueueClient()
    with SessionLocal() as db:
        article = save_record(db, "articles", {
            "id": "article-netease-review-2",
            "title": "智心AI网易号待复验",
            "status": "ready",
            "publishStatus": "submitted_for_review",
            "indexStatus": "not_submitted",
            "contentMarkdown": "这是另一篇需要复验的文章正文。",
        })
        order = save_record(db, "mediaOrders", {
            "id": "media-order-review-2",
            "articleId": article["id"],
            "articleTitle": article["title"],
            "resourceName": "网易号账号",
            "status": "review_required",
            "backlinkStatus": "blocked",
            "backlinkUrl": "",
            "reviewUrl": "https://www.163.com/dy/article/OLD.html",
            "platformStatus": "submitted_for_review",
            "reviewStatus": "pending_public_visibility",
        })
        task = create_task(db, "media-publication-recheck", "Recheck NetEase stale publication", {
            "orderId": order["id"],
            "provider": "Google",
            "checkImmediately": True,
        }, "media")

        result = TaskExecutor(db, queue, url_fetcher=lambda url: "无关旧文章标题和正文").run_task(task["id"])

        assert result["status"] == "succeeded"
        assert result["result"]["verified"] is False
        updated_order = [item for item in list_records(db, "mediaOrders") if item["id"] == order["id"]][0]
        assert updated_order["status"] == "review_required"
        assert updated_order["backlinkUrl"] == ""
        assert updated_order["reviewUrl"] == "https://www.163.com/dy/article/OLD.html"
        assert list_records(db, "indexSubmissions") == []


def test_publication_discovery_command_inherits_media_order_owner_without_active_actor(monkeypatch):
    class NoBypassSettings:
        auth_test_bypass_user_id = ""

    monkeypatch.setattr(service_module, "get_settings", lambda: NoBypassSettings())
    owner_id = "member-discovery-owner"

    with SessionLocal() as db:
        with actor_scope(ActorContext.system_worker(owner_id)):
            article = save_record(db, "articles", {
                "id": "article-owner-discovery",
                "title": "Owner scoped discovery article",
                "status": "ready",
                "contentMarkdown": "Owner scoped discovery body.",
            })
            artifact = save_record(db, "mediaAuthArtifacts", {
                "id": "artifact-owner-discovery",
                "sessionId": "session-owner-discovery",
                "status": "active",
                "authorizationEvidence": {
                    "strongCookiePresent": True,
                    "workspaceReady": True,
                },
            })
            account = save_record(db, "mediaAccounts", {
                "id": "media-account-owner-discovery",
                "platform": "sohu",
                "name": "Owner discovery account",
                "status": "active",
                "credentialStatus": "active",
                "authArtifactId": artifact["id"],
            })
            save_record(db, "mediaAccountBindings", {
                "id": "media-account-binding-owner-discovery",
                "mediaAccountId": account["id"],
                "deviceId": "desktop-device-owner-discovery",
                "sessionId": artifact["sessionId"],
                "artifactId": artifact["id"],
                "platform": "sohu",
                "status": "active",
            })
            order = save_record(db, "mediaOrders", {
                "id": "media-order-owner-discovery",
                "articleId": article["id"],
                "articleTitle": article["title"],
                "mediaAccountId": account["id"],
                "platform": "sohu",
                "status": "review_required",
                "reviewUrl": "https://mp.sohu.com/review/owner-discovery",
            })

        queued = queue_media_publication_discovery(db, {
            "orderId": order["id"],
            "forceDiscovery": True,
        })

        command_id = queued["desktopCommand"]["id"]
        command = get_record(db, "desktopCommands", command_id)
        record = db.get(Record, command_id)
        assert command["ownerId"] == owner_id
        assert record is not None
        assert record.owner_id == owner_id
        assert queued["mediaOrder"]["ownerId"] == owner_id


def test_scheduler_enqueues_media_publication_rechecks_for_pending_public_visibility():
    queue = MemoryQueueClient()
    with SessionLocal() as db:
        save_record(db, "mediaOrders", {
            "id": "media-order-schedule-review",
            "articleTitle": "Scheduled NetEase Review",
            "resourceName": "网易号账号",
            "status": "review_required",
            "backlinkStatus": "blocked",
            "backlinkUrl": "",
            "reviewUrl": "https://www.163.com/dy/article/SCHEDULED.html",
            "platformStatus": "submitted_for_review",
            "reviewStatus": "pending_public_visibility",
        })

        result = Scheduler(db, queue).enqueue_due_jobs()

        assert result["mediaPublicationRecheck"] == 1
        queued = queue.messages["media"][0]
        assert queued["type"] == "media-publication-recheck"
        assert queued["payload"]["orderId"] == "media-order-schedule-review"


def recheck_backoff_settings():
    return Settings(
        database_url="sqlite://",
        media_recheck_backoff_base_seconds=900.0,
        media_recheck_backoff_max_seconds=86400.0,
        media_recheck_max_attempts=40,
    )


def save_scheduled_review_order(db, order_id, public_check_count, public_check_at):
    return save_record(db, "mediaOrders", {
        "id": order_id,
        "articleTitle": "Scheduled NetEase Review",
        "status": "review_required",
        "backlinkStatus": "blocked",
        "backlinkUrl": "",
        "reviewUrl": "https://www.163.com/dy/article/SCHEDULED.html",
        "platformStatus": "submitted_for_review",
        "reviewStatus": "pending_public_visibility",
        "publicCheckCount": public_check_count,
        "publicCheckAt": public_check_at,
    })


def test_scheduler_holds_media_recheck_inside_the_backoff_window(monkeypatch):
    monkeypatch.setattr("app.config.get_settings", lambda: recheck_backoff_settings())
    queue = MemoryQueueClient()
    with SessionLocal() as db:
        save_scheduled_review_order(
            db,
            "media-order-schedule-backoff",
            3,
            app_time.now().isoformat(timespec="seconds"),
        )

        result = Scheduler(db, queue).enqueue_due_jobs()

        assert result["mediaPublicationRecheck"] == 0
        assert "media" not in queue.messages


def test_scheduler_rechecks_media_order_once_the_backoff_window_has_passed(monkeypatch):
    monkeypatch.setattr("app.config.get_settings", lambda: recheck_backoff_settings())
    queue = MemoryQueueClient()
    with SessionLocal() as db:
        save_scheduled_review_order(
            db,
            "media-order-schedule-backoff-elapsed",
            3,
            (app_time.now() - timedelta(hours=2)).isoformat(timespec="seconds"),
        )

        result = Scheduler(db, queue).enqueue_due_jobs()

        assert result["mediaPublicationRecheck"] == 1
        queued = queue.messages["media"][0]
        assert queued["payload"]["orderId"] == "media-order-schedule-backoff-elapsed"


def test_scheduler_stops_rechecking_media_order_at_the_attempt_cap(monkeypatch):
    monkeypatch.setattr("app.config.get_settings", lambda: recheck_backoff_settings())
    queue = MemoryQueueClient()
    with SessionLocal() as db:
        save_scheduled_review_order(
            db,
            "media-order-schedule-recheck-cap",
            40,
            (app_time.now() - timedelta(days=30)).isoformat(timespec="seconds"),
        )

        result = Scheduler(db, queue).enqueue_due_jobs()

        assert result["mediaPublicationRecheck"] == 0
        order = get_record(db, "mediaOrders", "media-order-schedule-recheck-cap")
        assert order["publicCheckStatus"] == "exhausted"
        assert order["backlinkStatus"] == "blocked"
        # Giving up on the recheck must not silently fail the order: whether the
        # publication counts is still an operator decision.
        assert order["status"] == "review_required"


def test_scheduler_gives_up_on_a_capped_order_only_once(monkeypatch):
    monkeypatch.setattr("app.config.get_settings", lambda: recheck_backoff_settings())
    queue = MemoryQueueClient()
    with SessionLocal() as db:
        save_scheduled_review_order(
            db,
            "media-order-schedule-cap-idempotent",
            40,
            (app_time.now() - timedelta(days=30)).isoformat(timespec="seconds"),
        )

        Scheduler(db, queue).enqueue_due_jobs()
        first = get_record(db, "mediaOrders", "media-order-schedule-cap-idempotent")
        result = Scheduler(db, queue).enqueue_due_jobs()

        assert result["mediaPublicationRecheck"] == 0
        second = get_record(db, "mediaOrders", "media-order-schedule-cap-idempotent")
        assert second["publicCheckStatus"] == "exhausted"
        assert second["updatedAt"] == first["updatedAt"]


def test_media_recheck_backoff_doubles_from_the_base_up_to_the_ceiling(monkeypatch):
    monkeypatch.setattr("app.config.get_settings", lambda: recheck_backoff_settings())

    assert worker_module.media_publication_recheck_backoff_seconds(0) == 0.0
    assert worker_module.media_publication_recheck_backoff_seconds(1) == 0.0
    assert worker_module.media_publication_recheck_backoff_seconds(2) == 1800.0
    assert worker_module.media_publication_recheck_backoff_seconds(3) == 3600.0
    assert worker_module.media_publication_recheck_backoff_seconds(50) == 86400.0


def test_media_recheck_backoff_disabled_by_zero_base(monkeypatch):
    monkeypatch.setattr("app.config.get_settings", lambda: Settings(
        database_url="sqlite://",
        media_recheck_backoff_base_seconds=0.0,
        media_recheck_backoff_max_seconds=86400.0,
        media_recheck_max_attempts=40,
    ))

    assert worker_module.media_publication_recheck_backoff_seconds(9) == 0.0
    assert worker_module.media_publication_recheck_is_due({
        "publicCheckCount": 9,
        "publicCheckAt": app_time.now().isoformat(timespec="seconds"),
    }) is True


def test_media_recheck_is_due_measures_the_gap_since_the_last_check(monkeypatch):
    monkeypatch.setattr("app.config.get_settings", lambda: recheck_backoff_settings())
    two_hours_ago = (app_time.now() - timedelta(hours=2)).isoformat(timespec="seconds")
    just_now = app_time.now().isoformat(timespec="seconds")

    assert worker_module.media_publication_recheck_is_due({
        "publicCheckCount": 3,
        "publicCheckAt": two_hours_ago,
    }) is True
    assert worker_module.media_publication_recheck_is_due({
        "publicCheckCount": 3,
        "publicCheckAt": just_now,
    }) is False
    assert worker_module.media_publication_recheck_is_due({
        "publicCheckCount": 1,
        "publicCheckAt": just_now,
    }) is True
    # A missing stamp means the order has never been rechecked: do not park it.
    assert worker_module.media_publication_recheck_is_due({"publicCheckCount": 5}) is True


def test_media_recheck_exhausted_at_the_attempt_cap(monkeypatch):
    monkeypatch.setattr("app.config.get_settings", lambda: recheck_backoff_settings())

    assert worker_module.media_publication_recheck_is_exhausted({"publicCheckCount": 40}) is True
    assert worker_module.media_publication_recheck_is_exhausted({"publicCheckCount": 39}) is False
    assert worker_module.media_publication_recheck_is_due({
        "publicCheckCount": 40,
        "publicCheckAt": (app_time.now() - timedelta(days=30)).isoformat(timespec="seconds"),
    }) is False


def test_media_recheck_cap_disabled_by_zero(monkeypatch):
    monkeypatch.setattr("app.config.get_settings", lambda: Settings(
        database_url="sqlite://",
        media_recheck_backoff_base_seconds=900.0,
        media_recheck_backoff_max_seconds=86400.0,
        media_recheck_max_attempts=0,
    ))

    # No cap means an order is never parked for good, but the backoff still
    # decides when the next check happens.
    assert worker_module.media_publication_recheck_is_exhausted({"publicCheckCount": 9999}) is False
    assert worker_module.media_publication_recheck_is_due({
        "publicCheckCount": 9999,
        "publicCheckAt": (app_time.now() - timedelta(days=30)).isoformat(timespec="seconds"),
    }) is True
    assert worker_module.media_publication_recheck_is_due({
        "publicCheckCount": 9999,
        "publicCheckAt": app_time.now().isoformat(timespec="seconds"),
    }) is False


def create_netease_discovery_records(db, order_id="media-order-discovery-schedule", create_article=True):
    save_record(db, "mediaAuthArtifacts", {
        "id": "artifact-netease-discovery-schedule",
        "sessionId": "session-netease-discovery-schedule",
        "status": "active",
        "authorizationEvidence": {
            "strongCookiePresent": True,
            "workspaceReady": True,
        },
    })
    save_record(db, "mediaAccounts", {
        "id": "account-netease-discovery-schedule",
        "name": "网易号调度账号",
        "platform": "netease",
        "status": "active",
        "credentialStatus": "active",
        "authArtifactId": "artifact-netease-discovery-schedule",
    })
    save_record(db, "mediaAccountBindings", {
        "id": "binding-netease-discovery-schedule",
        "mediaAccountId": "account-netease-discovery-schedule",
        "sessionId": "session-netease-discovery-schedule",
        "artifactId": "artifact-netease-discovery-schedule",
        "deviceId": "device-netease-discovery-schedule",
        "platform": "netease",
        "status": "active",
    })
    article_id = "article-netease-discovery-schedule"
    if create_article:
        save_record(db, "articles", {
            "id": article_id,
            "title": "缃戞槗鍙峰鏍稿悗鑷姩鍙戠幇鍏紑閾炬帴",
            "contentMarkdown": "Netease publication discovery scheduler article.",
            "status": "ready",
        })
    return save_record(db, "mediaOrders", {
        "id": order_id,
        "articleId": article_id,
        "articleTitle": "网易号审核后自动发现公开链接",
        "resourceId": "account:account-netease-discovery-schedule",
        "resourceName": "网易号调度账号",
        "mediaAccountId": "account-netease-discovery-schedule",
        "platform": "netease",
        "status": "review_required",
        "backlinkStatus": "blocked",
        "backlinkUrl": "",
        "reviewUrl": "",
        "platformStatus": "submitted_for_review",
        "reviewStatus": "pending_public_visibility",
        "publicDiscoveryStatus": "pending",
    })


def create_sohu_discovery_records(db, order_id="media-order-sohu-discovery-schedule", create_article=True):
    save_record(db, "mediaAuthArtifacts", {
        "id": "artifact-sohu-discovery-schedule",
        "sessionId": "session-sohu-discovery-schedule",
        "platform": "sohu",
        "status": "active",
        "authorizationEvidence": {
            "strongCookiePresent": True,
            "workspaceReady": True,
        },
    })
    save_record(db, "mediaAccounts", {
        "id": "account-sohu-discovery-schedule",
        "name": "Sohu Discovery Account",
        "platform": "sohu",
        "status": "active",
        "credentialStatus": "active",
        "authArtifactId": "artifact-sohu-discovery-schedule",
    })
    save_record(db, "mediaAccountBindings", {
        "id": "binding-sohu-discovery-schedule",
        "mediaAccountId": "account-sohu-discovery-schedule",
        "sessionId": "session-sohu-discovery-schedule",
        "artifactId": "artifact-sohu-discovery-schedule",
        "deviceId": "device-sohu-discovery-schedule",
        "platform": "sohu",
        "status": "active",
    })
    article_id = "article-sohu-discovery-schedule"
    if create_article:
        save_record(db, "articles", {
            "id": article_id,
            "title": "Sohu pending public discovery",
            "contentMarkdown": "Sohu publication discovery scheduler article.",
            "status": "ready",
        })
    return save_record(db, "mediaOrders", {
        "id": order_id,
        "articleId": article_id,
        "articleTitle": "Sohu pending public discovery",
        "resourceId": "account:account-sohu-discovery-schedule",
        "resourceName": "Sohu Discovery Account",
        "mediaAccountId": "account-sohu-discovery-schedule",
        "platform": "sohu",
        "status": "review_required",
        "backlinkStatus": "reviewing",
        "backlinkUrl": "",
        "reviewUrl": "https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?contentStatus=1&newsId=1051344766",
        "platformStatus": "submitted_for_review",
        "reviewStatus": "pending_public_visibility",
        "publicDiscoveryStatus": "pending",
    })


def test_scheduler_queues_desktop_discovery_for_url_less_netease_review_order():
    queue = MemoryQueueClient()
    with SessionLocal() as db:
        order = create_netease_discovery_records(db)

        result = Scheduler(db, queue).enqueue_due_jobs()

        assert result["mediaPublicationDiscovery"] == 1
        commands = list_records(db, "desktopCommands")
        assert len(commands) == 1
        assert commands[0]["type"] == "discover_publication"
        assert commands[0]["deviceId"] == "device-netease-discovery-schedule"
    assert commands[0]["payload"]["mediaOrderId"] == order["id"]


def test_scheduler_skips_desktop_discovery_for_deleted_article_order():
    queue = MemoryQueueClient()
    with SessionLocal() as db:
        order = create_netease_discovery_records(
            db,
            "media-order-discovery-deleted-article",
            create_article=False,
        )

        result = Scheduler(db, queue).enqueue_due_jobs()

        assert result["mediaPublicationDiscovery"] == 0
        assert list_records(db, "desktopCommands") == []
        updated = get_record(db, "mediaOrders", order["id"])
        assert updated["publicDiscoveryStatus"] == "failed"
        assert "article no longer exists" in updated["errorMessage"]


def test_scheduler_queues_desktop_discovery_for_private_sohu_review_url():
    queue = MemoryQueueClient()
    with SessionLocal() as db:
        order = create_sohu_discovery_records(db)

        result = Scheduler(db, queue).enqueue_due_jobs()

        assert result["mediaPublicationDiscovery"] == 1
        commands = list_records(db, "desktopCommands")
        assert len(commands) == 1
        assert commands[0]["type"] == "discover_publication"
        assert commands[0]["deviceId"] == "device-sohu-discovery-schedule"
        assert commands[0]["payload"]["mediaOrderId"] == order["id"]


def test_scheduler_does_not_duplicate_active_netease_publication_discovery_command():
    queue = MemoryQueueClient()
    with SessionLocal() as db:
        order = create_netease_discovery_records(db, "media-order-discovery-dedup")
        save_record(db, "desktopCommands", {
            "id": "desktop-command-discovery-existing",
            "deviceId": "device-netease-discovery-schedule",
            "type": "discover_publication",
            "mediaAccountId": "account-netease-discovery-schedule",
            "payload": {"mediaOrderId": order["id"]},
            "status": "queued",
            "result": {},
        })

        result = Scheduler(db, queue).enqueue_due_jobs()

        assert result["mediaPublicationDiscovery"] == 0
        assert len(list_records(db, "desktopCommands")) == 1


def test_scheduler_discovers_legacy_netease_order_from_account_resource_id():
    queue = MemoryQueueClient()
    with SessionLocal() as db:
        order = create_netease_discovery_records(db, "media-order-discovery-legacy")
        legacy_order = dict(order)
        legacy_order.pop("mediaAccountId", None)
        legacy_order.pop("platform", None)
        legacy_order.pop("publicDiscoveryStatus", None)
        save_record(db, "mediaOrders", legacy_order)

        result = Scheduler(db, queue).enqueue_due_jobs()

        assert result["mediaPublicationDiscovery"] == 1
        command = list_records(db, "desktopCommands")[0]
        assert command["payload"]["mediaOrderId"] == order["id"]


def test_scheduler_respects_recent_netease_publication_discovery_backoff():
    queue = MemoryQueueClient()
    with SessionLocal() as db:
        order = create_netease_discovery_records(db, "media-order-discovery-backoff")
        save_record(db, "mediaOrders", {
            **order,
            "publicDiscoveryStatus": "not_found",
            "lastPublicDiscoveryAt": datetime.now().isoformat(timespec="seconds"),
        })

        result = Scheduler(db, queue).enqueue_due_jobs()

        assert result["mediaPublicationDiscovery"] == 0
        assert list_records(db, "desktopCommands") == []


def pending_public_image_publication_evidence():
    expected = [
        {"assetId": "asset-a", "sectionId": "section-a", "position": 1, "idempotencyKey": "key-a"},
        {"assetId": "asset-b", "sectionId": "section-b", "position": 3, "idempotencyKey": "key-b"},
    ]
    observed_stage = {
        "expectedCount": 2,
        "observedCount": 2,
        "verifiedCount": 2,
        "status": "verified",
        "images": [
            {**expected[0], "platformImageUrl": "https://page.om.qq.com/a.png", "loaded": True},
            {**expected[1], "platformImageUrl": "https://page.om.qq.com/b.png", "loaded": True},
        ],
    }
    return {
        "version": 1,
        "status": "review_required",
        "expectedCount": 2,
        "expected": expected,
        "upload": {**observed_stage, "stage": "upload"},
        "draft": {**observed_stage, "stage": "draft"},
        "public": {
            "stage": "public",
            "status": "pending",
            "expectedCount": 2,
            "observedCount": 0,
            "verifiedCount": 0,
            "images": [],
        },
        "issues": ["PUBLIC_IMAGE_PENDING"],
    }


def verified_public_image_publication_evidence():
    evidence = pending_public_image_publication_evidence()
    evidence["status"] = "verified"
    evidence["public"] = {**evidence["upload"], "stage": "public"}
    evidence["issues"] = []
    return evidence


def create_penguin_image_gap_records(db, order_id, image_evidence):
    save_record(db, "mediaAuthArtifacts", {
        "id": "artifact-penguin-image-gap",
        "sessionId": "session-penguin-image-gap",
        "platform": "penguin",
        "status": "active",
        "authorizationEvidence": {
            "strongCookiePresent": True,
            "workspaceReady": True,
        },
    })
    save_record(db, "mediaAccounts", {
        "id": "account-penguin-image-gap",
        "name": "Penguin Image Gap Account",
        "platform": "penguin",
        "status": "active",
        "credentialStatus": "active",
        "authArtifactId": "artifact-penguin-image-gap",
    })
    save_record(db, "mediaAccountBindings", {
        "id": "binding-penguin-image-gap",
        "mediaAccountId": "account-penguin-image-gap",
        "sessionId": "session-penguin-image-gap",
        "artifactId": "artifact-penguin-image-gap",
        "deviceId": "device-penguin-image-gap",
        "platform": "penguin",
        "status": "active",
    })
    article_id = "article-penguin-image-gap"
    save_record(db, "articles", {
        "id": article_id,
        "title": "Penguin public page image gap article",
        "contentMarkdown": "The public page is live but its image evidence is still pending.",
        "status": "ready",
    })
    return save_record(db, "mediaOrders", {
        "id": order_id,
        "articleId": article_id,
        "articleTitle": "Penguin public page image gap",
        "resourceId": "account:account-penguin-image-gap",
        "resourceName": "Penguin Image Gap Account",
        "mediaAccountId": "account-penguin-image-gap",
        "platform": "penguin",
        "status": "review_required",
        "backlinkStatus": "reviewing",
        "backlinkUrl": "",
        "reviewUrl": "https://page.om.qq.com/page/penguin-public-001",
        "platformStatus": "submitted_for_review",
        "reviewStatus": "pending_public_visibility",
        "publicDiscoveryStatus": "candidate_found",
        "imagePublicationEvidence": image_evidence,
    })


def test_scheduler_queues_desktop_discovery_for_penguin_public_page_image_gap():
    queue = MemoryQueueClient()
    with SessionLocal() as db:
        order = create_penguin_image_gap_records(
            db,
            "media-order-penguin-image-gap",
            pending_public_image_publication_evidence(),
        )

        result = Scheduler(db, queue).enqueue_due_jobs()

        # A public-page URL is already on file, so the plain recheck branch used to
        # take this order and could only ever report PUBLIC_IMAGE_EVIDENCE_INCOMPLETE:
        # refreshing that evidence needs a discover command on the desktop browser.
        assert result["mediaPublicationDiscovery"] == 1
        assert result["mediaPublicationRecheck"] == 0
        commands = list_records(db, "desktopCommands")
        assert len(commands) == 1
        assert commands[0]["type"] == "discover_publication"
        assert commands[0]["deviceId"] == "device-penguin-image-gap"
        assert commands[0]["payload"]["mediaOrderId"] == order["id"]
        assert commands[0]["payload"]["publicUrl"] == order["reviewUrl"]
        assert commands[0]["payload"]["imagePublicationEvidence"]["expectedCount"] == 2
        assert [
            task for task in list_records(db, "tasks")
            if task.get("type") == "media-publication-recheck"
        ] == []
        assert get_record(db, "mediaOrders", order["id"])["publicDiscoveryStatus"] == "queued"


def test_scheduler_keeps_server_side_recheck_when_public_image_evidence_is_verified():
    queue = MemoryQueueClient()
    with SessionLocal() as db:
        order = create_penguin_image_gap_records(
            db,
            "media-order-penguin-image-verified",
            verified_public_image_publication_evidence(),
        )

        result = Scheduler(db, queue).enqueue_due_jobs()

        assert result["mediaPublicationDiscovery"] == 0
        assert result["mediaPublicationRecheck"] == 1
        assert list_records(db, "desktopCommands") == []
        queued = queue.messages["media"][0]
        assert queued["type"] == "media-publication-recheck"
        assert queued["payload"]["orderId"] == order["id"]


def test_scheduler_holds_penguin_image_gap_discovery_inside_the_backoff_window():
    queue = MemoryQueueClient()
    with SessionLocal() as db:
        order = create_penguin_image_gap_records(
            db,
            "media-order-penguin-image-gap-backoff",
            pending_public_image_publication_evidence(),
        )
        save_record(db, "mediaOrders", {
            **order,
            "lastPublicDiscoveryAt": datetime.now().isoformat(timespec="seconds"),
        })

        result = Scheduler(db, queue).enqueue_due_jobs()

        assert result["mediaPublicationDiscovery"] == 0
        assert result["mediaPublicationRecheck"] == 0
        assert list_records(db, "desktopCommands") == []


def test_worker_updates_auto_publish_task_after_generating_articles():
    queue = MemoryQueueClient()
    with SessionLocal() as db:
        rule = save_record(db, "generationRules", {
            "id": "rule-auto-publish-1",
            "name": "Auto Publish Rule",
            "content": "Use a practical SEO workflow and include publishing steps.",
        })
        knowledge = save_record(db, "knowledgeItems", {
            "id": "knowledge-auto-publish-1",
            "title": "Auto publish facts",
            "content": "Zhixin AI supports batch AI writing and channel publishing.",
        })
        asset = save_record(db, "assets", {
            "id": "asset-auto-publish-1",
            "filename": "auto-publish.png",
            "altText": "Auto publish dashboard",
        })
        auto_task = save_record(db, "autoPublishTasks", {
            "id": "auto-publish-1",
            "name": "Queued batch",
            "selectedKeywords": ["AI SEO", "GEO visibility"],
            "generatedArticleIds": [],
            "status": "queued",
            "successCount": 0,
            "failedCount": 0,
        })
        task = create_task(db, "auto-publish", "Auto publish batch", {
            "autoPublishTaskId": auto_task["id"],
            "selectedKeywords": auto_task["selectedKeywords"],
            "ruleId": rule["id"],
            "ruleName": rule["name"],
            "knowledgeIds": [knowledge["id"]],
            "assetIds": [asset["id"]],
            "targetChannels": ["site:wordpress", "media:zhihu"],
            "scheduleMode": "once",
        }, "publish")

        result = TaskExecutor(
            db,
            queue,
            llm_generator=lambda context: {
                "title": f"{context['keyword']} batch draft",
                "summary": "Batch summary",
                "metaDescription": "Batch meta",
                "contentMarkdown": f"# Batch\n\n{context['keyword']}\n\n{context['knowledgeItems'][0]['content']}",
                "keywords": [context["keyword"]],
                "tags": ["auto-publish", "deepseek"],
            },
        ).run_task(task["id"])

        assert result["status"] == "succeeded"
        updated = [item for item in list_records(db, "autoPublishTasks") if item["id"] == auto_task["id"]][0]
        assert updated["status"] == "succeeded"
        assert updated["successCount"] == 2
        assert len(updated["generatedArticleIds"]) == 2
        articles = list_records(db, "articles")
        assert len(articles) == 2
        assert all(article["source"] == "deepseek_ai" for article in articles)
        assert all(article["llmProvider"] == "deepseek" for article in articles)
        assert all(article["writerContext"]["source"] == "auto-publish" for article in articles)
        assert all(article["writerContext"]["autoPublishTaskId"] == auto_task["id"] for article in articles)
        assert all(article["writerContext"]["rule"]["id"] == rule["id"] for article in articles)
        assert all(article["writerContext"]["knowledgeItems"][0]["id"] == knowledge["id"] for article in articles)
        assert all(article["writerContext"]["assets"][0]["id"] == asset["id"] for article in articles)
        assert all(article["writerContext"]["targetChannels"] == ["site:wordpress", "media:zhihu"] for article in articles)
        llm_requests = list_records(db, "llmRequests")
        assert len(llm_requests) == 2
        assert {item["taskId"] for item in llm_requests} == {task["id"]}
        assert {item["articleId"] for item in llm_requests} == {article["id"] for article in articles}
        prompt_text = "\n".join(message["content"] for item in llm_requests for message in item["requestPayload"]["messages"])
        assert "Auto Publish Rule" in prompt_text
        assert "Zhixin AI supports batch AI writing and channel publishing." in prompt_text
        assert "Auto publish dashboard" in prompt_text
        assert "site:wordpress" in prompt_text


def test_worker_auto_publish_queues_real_desktop_commands_for_authorized_media_accounts():
    queue = MemoryQueueClient()
    with SessionLocal() as db:
        artifact = save_record(db, "mediaAuthArtifacts", {
            "id": "artifact-auto-publish-zhihu",
            "sessionId": "session-auto-publish-zhihu",
            "status": "active",
            "authorizationEvidence": {
                "strongCookiePresent": True,
                "workspaceReady": True,
            },
        })
        account = save_record(db, "mediaAccounts", {
            "id": "media-account-auto-publish-zhihu",
            "platform": "zhihu",
            "name": "Zhihu Publishing Account",
            "accountName": "Zhihu Author",
            "status": "active",
            "credentialStatus": "active",
            "authArtifactId": artifact["id"],
            "isCanonical": True,
        })
        save_record(db, "mediaAccountBindings", {
            "id": "binding-auto-publish-zhihu",
            "mediaAccountId": account["id"],
            "artifactId": artifact["id"],
            "sessionId": artifact["sessionId"],
            "deviceId": "desktop-auto-publish-1",
            "status": "active",
        })
        existing_article = save_record(db, "articles", {
            "id": "article-auto-publish-existing",
            "title": "Existing article ready to publish",
            "summary": "Existing summary",
            "contentMarkdown": "# Existing\n\nPublish this article through Zhihu.",
            "keywords": ["AI SEO"],
            "status": "ready",
        })
        auto_task = save_record(db, "autoPublishTasks", {
            "id": "auto-publish-existing-article",
            "name": "Existing article batch",
            "articleIds": [existing_article["id"]],
            "mediaAccountIds": [account["id"]],
            "status": "queued",
            "publishCount": 1,
            "successCount": 0,
            "failedCount": 0,
        })
        task = create_task(db, "auto-publish", "Publish existing article", {
            "autoPublishTaskId": auto_task["id"],
            "articleIds": [existing_article["id"]],
            "mediaAccountIds": [account["id"]],
            "scheduleMode": "once",
            "provider": "IndexNow",
            "checkImmediately": True,
            "confirmPublish": True,
        }, "publish")

        result = TaskExecutor(db, queue).run_task(task["id"])

        assert result["status"] == "succeeded"
        assert result["result"]["generatedArticleIds"] == []
        assert result["result"]["articleIds"] == [existing_article["id"]]
        assert result["result"]["queuedPublishCount"] == 1
        commands = list_records(db, "desktopCommands")
        assert len(commands) == 1
        command = commands[0]
        assert command["type"] == "publish_article"
        assert command["deviceId"] == "desktop-auto-publish-1"
        assert command["mediaAccountId"] == account["id"]
        assert command["payload"]["articleId"] == existing_article["id"]
        assert command["payload"]["autoPublishTaskId"] == auto_task["id"]
        assert command["payload"]["contentMarkdown"] == existing_article["contentMarkdown"]
        assert command["payload"]["publishMode"] == "publish"
        assert command["payload"]["submitIndex"] is False
        media_orders = list_records(db, "mediaOrders")
        assert len(media_orders) == 1
        assert media_orders[0]["articleId"] == existing_article["id"]
        assert media_orders[0]["sourceCommandId"] == command["id"]
        assert media_orders[0]["status"] == "pending"
        assert list_records(db, "indexSubmissions") == []
        updated_batch = list_records(db, "autoPublishTasks")[0]
        assert updated_batch["status"] == "publishing"
        assert updated_batch["articleIds"] == [existing_article["id"]]
        assert updated_batch["desktopCommandIds"] == [command["id"]]
        assert updated_batch["publishPendingCount"] == 1


def test_worker_auto_publish_records_every_target_when_one_command_cannot_be_queued(monkeypatch):
    queue = MemoryQueueClient()
    with SessionLocal() as db:
        article = save_record(db, "articles", {
            "id": "article-partial-dispatch",
            "title": "Partial dispatch article",
            "contentMarkdown": "Partial dispatch body.",
            "status": "ready",
        })
        account_ids = []
        for suffix in ("ok", "blocked"):
            artifact = save_record(db, "mediaAuthArtifacts", {
                "id": f"artifact-partial-{suffix}",
                "sessionId": f"session-partial-{suffix}",
                "status": "active",
                "authorizationEvidence": {"strongCookiePresent": True, "workspaceReady": True},
            })
            account = save_record(db, "mediaAccounts", {
                "id": f"media-account-partial-{suffix}",
                "platform": "zhihu" if suffix == "ok" else "sohu",
                "name": f"Partial {suffix}",
                "status": "active",
                "credentialStatus": "active",
                "authArtifactId": artifact["id"],
                "isCanonical": True,
            })
            save_record(db, "mediaAccountBindings", {
                "id": f"binding-partial-{suffix}",
                "mediaAccountId": account["id"],
                "artifactId": artifact["id"],
                "sessionId": artifact["sessionId"],
                "deviceId": f"desktop-partial-{suffix}",
                "status": "active",
            })
            account_ids.append(account["id"])
        batch = save_record(db, "autoPublishTasks", {
            "id": "auto-publish-partial-dispatch",
            "name": "Partial dispatch",
            "articleIds": [article["id"]],
            "mediaAccountIds": account_ids,
            "status": "queued",
        })
        task = create_task(db, "auto-publish", "Partial dispatch", {
            "autoPublishTaskId": batch["id"],
            "articleIds": [article["id"]],
            "mediaAccountIds": account_ids,
            "scheduleMode": "once",
            "confirmPublish": True,
        }, "publish")
        real_queue = queue_article_media_publish_command

        def queue_with_one_failure(db_session, queued_article, account_id, payload, source):
            if account_id == account_ids[1]:
                raise RuntimeError("TARGET_QUEUE_FAILED")
            return real_queue(db_session, queued_article, account_id, payload, source)

        monkeypatch.setattr(worker_module, "queue_article_media_publish_command", queue_with_one_failure)
        result = TaskExecutor(db, queue).run_task(task["id"])

        assert result["status"] == "succeeded"
        commands = list_records(db, "desktopCommands")
        assert len(commands) == 2
        assert {command["status"] for command in commands} == {"queued", "failed"}
        successful_command = next(command for command in commands if command["status"] == "queued")
        db_result = save_record(db, "desktopCommands", {**successful_command, "status": "succeeded"})
        assert db_result["status"] == "succeeded"
        updated_batch = sync_auto_publish_task_status(db, batch["id"])
        assert updated_batch["status"] == "partial_failed"
        assert updated_batch["queuedPublishCount"] == 2
        assert updated_batch["publishSucceededCount"] == 1
        assert updated_batch["publishFailedCount"] == 1


def test_publish_command_falls_back_to_writer_context_inline_images():
    with SessionLocal() as db:
        article = save_record(db, "articles", {
            "id": "article-writer-context-images",
            "title": "Writer context images",
            "contentMarkdown": "Writer context body.",
            "status": "ready",
            "sections": [{"id": "s1", "title": "第一节"}],
            "inlineImages": [],
            "contentBlocks": [],
            "writerContext": {
                "inlineImages": [{
                    "assetId": "asset-writer-1",
                    "purpose": "inline",
                    "sectionId": "s1",
                    "url": "/uploads/assets/asset-writer-1.png",
                    "altText": "配图一",
                }],
                "contentBlocks": [
                    {"type": "section", "sectionId": "s1", "title": "第一节", "content": "Writer context body."},
                    {"type": "image", "sectionId": "s1", "assetId": "asset-writer-1", "altText": "配图一"},
                ],
            },
        })
        artifact = save_record(db, "mediaAuthArtifacts", {
            "id": "artifact-writer-context",
            "sessionId": "session-writer-context",
            "status": "active",
            "authorizationEvidence": {"strongCookiePresent": True, "workspaceReady": True},
        })
        account = save_record(db, "mediaAccounts", {
            "id": "media-account-writer-context",
            "platform": "csdn",
            "name": "Writer context CSDN",
            "status": "active",
            "credentialStatus": "active",
            "authArtifactId": artifact["id"],
            "isCanonical": True,
        })
        save_record(db, "mediaAccountBindings", {
            "id": "binding-writer-context",
            "mediaAccountId": account["id"],
            "artifactId": artifact["id"],
            "sessionId": artifact["sessionId"],
            "deviceId": "desktop-writer-context",
            "status": "active",
        })

        queued = queue_article_media_publish_command(db, article, account["id"], {"confirmPublish": True})

        payload = queued["command"]["payload"]
        assert [image["url"] for image in payload["inlineImages"]] == ["/uploads/assets/asset-writer-1.png"]
        image_blocks = [block for block in payload["contentBlocks"] if block["type"] == "image"]
        assert len(image_blocks) == 1
        assert image_blocks[0]["assetId"] == "asset-writer-1"
        assert image_blocks[0]["url"] == "/uploads/assets/asset-writer-1.png"
        assert image_blocks[0]["altText"] == "配图一"


def test_auto_publish_status_surfaces_manual_platform_verification():
    with SessionLocal() as db:
        batch = save_record(db, "autoPublishTasks", {
            "id": "auto-publish-manual-action",
            "name": "Sohu manual verification",
            "articleIds": ["article-manual-action"],
            "mediaAccountIds": ["media-account-sohu-manual"],
            "status": "publishing",
        })
        save_record(db, "desktopCommands", {
            "id": "desktop-command-sohu-manual",
            "type": "publish_article",
            "mediaAccountId": "media-account-sohu-manual",
            "payload": {
                "autoPublishTaskId": batch["id"],
                "articleId": "article-manual-action",
                "dedupeKey": "manual-action:sohu",
                "attempt": 1,
            },
            "status": "failed",
            "result": {
                "platformStatus": "manual_verification_required",
                "message": "搜狐封面上传触发安全验证，请在桌面端浏览器完成验证后重试。",
            },
            "errorMessage": "SOHU_MANUAL_ACTION_REQUIRED",
        })

        updated_batch = sync_auto_publish_task_status(db, batch["id"])

        assert updated_batch["status"] == "manual_action_required"
        assert updated_batch["publishManualActionCount"] == 1
        assert updated_batch["publishFailedCount"] == 1
        assert "安全验证" in updated_batch["lastError"]


def test_worker_executes_auto_geo_rewrite_task_and_updates_batch():
    queue = MemoryQueueClient()
    with SessionLocal() as db:
        first = save_record(db, "geoQuestions", {
            "id": "geo-question-1",
            "keyword": "AI SEO",
            "question": "Which AI SEO platform is recommended?",
            "platform": "DeepSeek",
            "sourceMedia": "example.com",
            "answerExcerpt": "Competitors are recommended.",
            "brandMention": False,
            "competitorMention": True,
        })
        second = save_record(db, "geoQuestions", {
            "id": "geo-question-2",
            "keyword": "AI publishing",
            "question": "How to automate publishing?",
            "platform": "ChatGPT",
            "sourceMedia": "example.org",
            "answerExcerpt": "Manual workflows are discussed.",
            "brandMention": False,
            "competitorMention": False,
        })
        rule = save_record(db, "generationRules", {"id": "rule-geo-1", "name": "GEO Rule", "content": "Use brand-first GEO answer structure."})
        knowledge = save_record(db, "knowledgeItems", {"id": "knowledge-geo-1", "title": "GEO Facts", "content": "Zhixin AI supports GEO visibility workflows."})
        asset = save_record(db, "assets", {"id": "asset-geo-1", "filename": "geo.png", "altText": "GEO dashboard"})
        auto_task = save_record(db, "autoPublishTasks", {
            "id": "auto-geo-task-1",
            "name": "Auto GEO rewrite",
            "status": "queued",
            "targetPlatforms": ["DeepSeek", "ChatGPT"],
            "generatedArticleIds": [],
            "successCount": 0,
            "failedCount": 0,
        })
        task = create_task(db, "auto-geo-rewrite", "Auto GEO rewrite", {
            "autoGeoTaskId": auto_task["id"],
            "questionIds": [first["id"], second["id"]],
            "ruleId": rule["id"],
            "knowledgeIds": [knowledge["id"]],
            "assetIds": [asset["id"]],
        }, "ai")

        result = TaskExecutor(
            db,
            queue,
            llm_generator=lambda context: {
                "title": f"{context['keyword']} GEO model draft",
                "summary": "GEO model summary",
                "metaDescription": "GEO model meta",
                "contentMarkdown": f"# GEO\n\n{context['question']}\n\n{context['knowledgeItems'][0]['content']}",
                "keywords": [context["keyword"]],
                "tags": ["auto-geo", "deepseek"],
            },
        ).run_task(task["id"])

        assert result["status"] == "succeeded"
        updated = [item for item in list_records(db, "autoPublishTasks") if item["id"] == auto_task["id"]][0]
        assert updated["status"] == "succeeded"
        assert updated["successCount"] == 2
        assert len(updated["generatedArticleIds"]) == 2
        articles = list_records(db, "articles")
        assert len(articles) == 2
        assert all(article["source"] == "deepseek_ai" for article in articles)
        assert all(article["llmProvider"] == "deepseek" for article in articles)
        assert all(article["writerContext"]["source"] == "auto-geo" for article in articles)
        assert {article["writerContext"]["geoQuestionId"] for article in articles} == {first["id"], second["id"]}
        assert all(article["writerContext"]["rule"]["id"] == rule["id"] for article in articles)
        assert all(article["writerContext"]["knowledgeItems"][0]["id"] == knowledge["id"] for article in articles)
        assert all(article["writerContext"]["assets"][0]["id"] == asset["id"] for article in articles)
        llm_requests = list_records(db, "llmRequests")
        assert len(llm_requests) == 2
        assert {item["taskId"] for item in llm_requests} == {task["id"]}
        prompt_text = "\n".join(message["content"] for item in llm_requests for message in item["requestPayload"]["messages"])
        assert "Which AI SEO platform is recommended?" in prompt_text
        assert "Zhixin AI supports GEO visibility workflows." in prompt_text
        assert "GEO dashboard" in prompt_text


def test_worker_failure_creates_notification_with_failure_context():
    queue = MemoryQueueClient()
    with SessionLocal() as db:
        task = create_task(db, "knowledge-fetch-url", "Fetch broken URL", {"knowledgeId": "missing", "url": "https://broken.test"}, "knowledge")

        result = TaskExecutor(db, queue, url_fetcher=lambda url: (_ for _ in ()).throw(RuntimeError("fetch failed"))).run_task(task["id"])

        assert result["status"] == "failed"
        assert result["errorMessage"]
        notifications = list_records(db, "notifications")
        assert len(notifications) == 1
        assert notifications[0]["level"] == "error"
        assert notifications[0]["target"]["taskId"] == task["id"]
        assert "fetch failed" in notifications[0]["message"] or "NOT_FOUND" in notifications[0]["message"]


def test_worker_success_creates_completion_notification_with_task_context():
    queue = MemoryQueueClient()
    with SessionLocal() as db:
        submission = save_record(db, "indexSubmissions", {
            "id": "success-submission-1",
            "articleTitle": "Successful inclusion",
            "url": "https://example.com/success",
            "provider": "Google",
            "inclusionStatus": "unchecked",
        })
        task = create_task(db, "inclusion-check", "Check successful inclusion", {"submissionId": submission["id"]}, "index")

        result = TaskExecutor(db, queue, search_index_service=FakeSearchIndexService()).run_task(task["id"])

        assert result["status"] == "succeeded"
        notifications = list_records(db, "notifications")
        assert len(notifications) == 1
        assert notifications[0]["level"] == "success"
        assert notifications[0]["target"]["taskId"] == task["id"]
        assert notifications[0]["target"]["taskType"] == "inclusion-check"
        assert notifications[0]["target"]["queue"] == "index"
        assert notifications[0]["target"]["indexSubmissionId"] == submission["id"]
        assert notifications[0]["href"] == "/published"
        assert "Check successful inclusion" in notifications[0]["message"]


def test_scheduler_queues_due_media_session_validation_and_deduplicates_active_commands():
    with SessionLocal() as db:
        save_record(db, "desktopDevices", {
            "id": "desktop-validation-1",
            "deviceName": "Validation Desktop",
            "status": "active",
            # A registered desktop always heartbeats on registration; without a
            # recent heartbeat the scheduler must treat the device as offline.
            "lastSeenAt": now_stamp(),
        })
        save_record(db, "mediaAccounts", {
            "id": "media-account-validation-due",
            "name": "Due NetEase account",
            "platform": "netease",
            "status": "active",
            "credentialStatus": "active",
            "authArtifactId": "artifact-validation-due",
            "profileKey": "profile-validation-due",
            "nextCredentialCheckAt": "2000-01-01T00:00:00+00:00",
        })
        save_record(db, "mediaAccountBindings", {
            "id": "binding-validation-due",
            "mediaAccountId": "media-account-validation-due",
            "deviceId": "desktop-validation-1",
            "status": "active",
        })
        save_record(db, "mediaAccounts", {
            "id": "media-account-validation-future",
            "name": "Future Zhihu account",
            "platform": "zhihu",
            "status": "active",
            "credentialStatus": "active",
            "authArtifactId": "artifact-validation-future",
            "nextCredentialCheckAt": "2999-01-01T00:00:00+00:00",
        })

        first = Scheduler(db, MemoryQueueClient()).enqueue_due_jobs()
        commands = list_records(db, "desktopCommands")

        assert first["mediaSessionValidation"] == 1
        assert len(commands) == 1
        assert commands[0]["type"] == "validate_session"
        assert commands[0]["mediaAccountId"] == "media-account-validation-due"
        assert commands[0]["deviceId"] == "desktop-validation-1"

        second = Scheduler(db, MemoryQueueClient()).enqueue_due_jobs()
        assert second["mediaSessionValidation"] == 0
        assert len(list_records(db, "desktopCommands")) == 1

        first_command = list_records(db, "desktopCommands")[0]
        save_record(db, "desktopCommands", {**first_command, "status": "failed"})
        due_account = next(item for item in list_records(db, "mediaAccounts") if item["id"] == "media-account-validation-due")
        save_record(db, "mediaAccounts", {
            **due_account,
            "status": "active",
            "credentialStatus": "stale",
            "nextCredentialCheckAt": "2000-01-01T00:00:00+00:00",
        })

        third = Scheduler(db, MemoryQueueClient()).enqueue_due_jobs()
        command_ids = [item["id"] for item in list_records(db, "desktopCommands")]
        assert third["mediaSessionValidation"] == 1
        assert len(command_ids) == 2
        assert len(set(command_ids)) == 2

        # An offline desktop must not receive a new command it can never claim.
        save_record(db, "desktopDevices", {**get_record(db, "desktopDevices", "desktop-validation-1"), "lastSeenAt": "01/01 00:00"})
        save_record(db, "mediaAccounts", {
            **due_account,
            "status": "active",
            "credentialStatus": "stale",
            "nextCredentialCheckAt": "2000-01-01T00:00:00+00:00",
        })

        fourth = Scheduler(db, MemoryQueueClient()).enqueue_due_jobs()
        assert fourth["mediaSessionValidation"] == 0
        assert len(list_records(db, "desktopCommands")) == 2


def seed_asset_cleanup_device(db, device_id, app_version="0.1.14", bound_owner="owner-cleanup-a", last_seen=None):
    return save_record(db, "desktopDevices", {
        "id": device_id,
        "deviceName": f"Asset cleanup {device_id}",
        "status": "active",
        "appVersion": app_version,
        "boundOwnerId": bound_owner,
        # A registered desktop heartbeats on registration; without a recent
        # stamp the scheduler must treat it as offline and never dispatch.
        "lastSeenAt": last_seen or now_stamp(),
    })


def queued_asset_cleanup_commands(db):
    return [item for item in list_records(db, "desktopCommands") if item["type"] == "cleanup_assets"]


def test_asset_cleanup_detects_shanghai_heartbeat_on_a_utc_server(monkeypatch):
    from datetime import timezone
    from app import desktop_channels

    current = datetime(2026, 10, 24, 13, 0, tzinfo=timezone.utc)

    class UtcServerClock(datetime):
        @classmethod
        def now(cls, tz=None):
            return current.astimezone(tz) if tz is not None else current.replace(tzinfo=None)

    monkeypatch.setattr(desktop_channels, "datetime", UtcServerClock)
    monkeypatch.setattr(app_time, "now", lambda: current.astimezone(app_time.display_timezone()))
    fresh = (app_time.now() - timedelta(minutes=1)).isoformat()
    stale = (app_time.now() - timedelta(minutes=20)).isoformat()
    with SessionLocal() as db:
        seed_asset_cleanup_device(db, "cleanup-utc-live", last_seen=fresh)
        seed_asset_cleanup_device(db, "cleanup-utc-offline", last_seen=stale)
        seed_asset_cleanup_device(db, "cleanup-utc-old", app_version="0.1.13", last_seen=fresh)

        assert Scheduler(db, MemoryQueueClient()).enqueue_desktop_asset_cleanup() == 1
        assert [c["deviceId"] for c in queued_asset_cleanup_commands(db)] == ["cleanup-utc-live"]


def test_asset_cleanup_cooldown_is_independent_for_each_device():
    current = app_time.now()
    finished = {
        "type": "cleanup_assets",
        "deviceId": "cleanup-a",
        "status": "succeeded",
        "updatedAt": current.isoformat(),
    }
    assert not worker_module.asset_cleanup_command_is_due([finished], "cleanup-a", now=current)
    assert worker_module.asset_cleanup_command_is_due([finished], "cleanup-b", now=current)


def test_scheduler_queues_asset_cleanup_for_a_live_device_on_the_version_floor():
    with SessionLocal() as db:
        seed_asset_cleanup_device(db, "desktop-cleanup-due")

        result = Scheduler(db, MemoryQueueClient()).enqueue_due_jobs()

        assert result["desktopAssetCleanup"] == 1
        commands = queued_asset_cleanup_commands(db)
        assert len(commands) == 1
        command = commands[0]
        assert command["deviceId"] == "desktop-cleanup-due"
        assert command["status"] == "queued"
        assert command["payload"]["assetsKeep"] == 50
        assert command["payload"]["assetsMaxAgeDays"] == 7
        assert command["payload"]["profilesMaxAgeDays"] == 14
        assert command["payload"]["source"] == "scheduler"


def test_scheduler_skips_asset_cleanup_for_an_offline_device():
    with SessionLocal() as db:
        # A command queued for a device that never polls is a command that
        # blocks every later sweep for it, so liveness is a hard gate.
        seed_asset_cleanup_device(db, "desktop-cleanup-offline", last_seen="01/01 00:00")

        result = Scheduler(db, MemoryQueueClient()).enqueue_due_jobs()

        assert result["desktopAssetCleanup"] == 0
        assert queued_asset_cleanup_commands(db) == []


def test_scheduler_skips_asset_cleanup_below_the_version_floor():
    with SessionLocal() as db:
        # Every device on this deployment reports 0.1.0-mvp, so the floor has
        # to hold until a rebuilt installer lands on the machine.
        seed_asset_cleanup_device(db, "desktop-cleanup-old", app_version="0.1.13")
        seed_asset_cleanup_device(db, "desktop-cleanup-pre-release", app_version="0.1.14-beta")

        result = Scheduler(db, MemoryQueueClient()).enqueue_due_jobs()

        assert result["desktopAssetCleanup"] == 0
        assert queued_asset_cleanup_commands(db) == []


def test_scheduler_accepts_asset_cleanup_above_the_version_floor():
    with SessionLocal() as db:
        seed_asset_cleanup_device(db, "desktop-cleanup-new", app_version="0.2.0")

        result = Scheduler(db, MemoryQueueClient()).enqueue_due_jobs()

        assert result["desktopAssetCleanup"] == 1
        assert [item["deviceId"] for item in queued_asset_cleanup_commands(db)] == ["desktop-cleanup-new"]


def test_scheduler_deduplicates_an_in_flight_asset_cleanup_command():
    with SessionLocal() as db:
        seed_asset_cleanup_device(db, "desktop-cleanup-dedup")

        first = Scheduler(db, MemoryQueueClient()).enqueue_due_jobs()
        assert first["desktopAssetCleanup"] == 1

        # The command is still queued, so a chatty scheduler must not turn a
        # cleanup sweep into a delete loop.
        second = Scheduler(db, MemoryQueueClient()).enqueue_due_jobs()
        assert second["desktopAssetCleanup"] == 0
        assert len(queued_asset_cleanup_commands(db)) == 1

        command = queued_asset_cleanup_commands(db)[0]
        save_record(db, "desktopCommands", {**command, "status": "failed", "updatedAt": now_stamp()})

        third = Scheduler(db, MemoryQueueClient()).enqueue_due_jobs()
        assert third["desktopAssetCleanup"] == 0
        assert len(queued_asset_cleanup_commands(db)) == 1


def test_scheduler_holds_asset_cleanup_inside_the_cooldown_window():
    with SessionLocal() as db:
        seed_asset_cleanup_device(db, "desktop-cleanup-cooldown")
        assert Scheduler(db, MemoryQueueClient()).enqueue_due_jobs()["desktopAssetCleanup"] == 1

        command = queued_asset_cleanup_commands(db)[0]
        save_record(db, "desktopCommands", {
            **command,
            "status": "succeeded",
            "updatedAt": now_stamp(),
        })
        assert Scheduler(db, MemoryQueueClient()).enqueue_due_jobs()["desktopAssetCleanup"] == 0

        # Past the cooldown the same device is eligible again, and the sweep
        # must not be blocked by another device's finished command either.
        stale = (app_time.now() - timedelta(hours=7)).isoformat(timespec="seconds")
        save_record(db, "desktopCommands", {**command, "status": "succeeded", "updatedAt": stale})
        assert Scheduler(db, MemoryQueueClient()).enqueue_due_jobs()["desktopAssetCleanup"] == 1
        assert len(queued_asset_cleanup_commands(db)) == 2


def test_asset_cleanup_keep_keys_span_every_owner():
    # A conservative cleanup keeps one stale directory; a wrong one logs out a
    # live session. So the keep set has to see past the device's own owner.
    with SessionLocal() as db:
        for owner_id, platform in (("owner-cleanup-a", "zhihu"), ("owner-cleanup-b", "csdn")):
            save_record(db, "mediaAccounts", {
                "id": f"account-{owner_id}",
                "name": f"{owner_id} account",
                "platform": platform,
                "status": "active",
                "credentialStatus": "active",
                "ownerId": owner_id,
                "profileKey": f"profile-{owner_id}",
            })
        save_record(db, "mediaAuthSessions", {
            "id": "session-cleanup-owner-c",
            "platform": "toutiao",
            "status": "active",
            "ownerId": "owner-cleanup-c",
        })
        save_record(db, "mediaAccountBindings", {
            "id": "binding-cleanup-owner-d",
            "mediaAccountId": "account-cleanup-owner-d",
            "profileKey": "profile-cleanup-owner-d",
            "ownerId": "owner-cleanup-d",
            "status": "active",
        })
        seed_asset_cleanup_device(db, "desktop-cleanup-owners")

        result = Scheduler(db, MemoryQueueClient()).enqueue_due_jobs()

        assert result["desktopAssetCleanup"] == 1
        keep_keys = set(queued_asset_cleanup_commands(db)[0]["payload"]["keepProfileKeys"])
        assert {
            "account-owner-cleanup-a", "profile-owner-cleanup-a",
            "account-owner-cleanup-b", "profile-owner-cleanup-b",
            "session-cleanup-owner-c",
            "profile-cleanup-owner-d",
        } <= keep_keys


def test_publish_task_failure_releases_article_for_retry():
    with SessionLocal() as db:
        article = save_record(db, "articles", {
            "id": "article-publish-failed",
            "title": "Publish failure retry",
            "status": "ready",
            "publishStatus": "pending",
            "publicationStatus": "pending",
        })
        executor = TaskExecutor(db, MemoryQueueClient(), llm_generator=lambda context: {})

        executor._mark_source_failed({
            "type": "publish-and-index",
            "payload": {"articleId": article["id"]},
        }, "CMS connection failed")

        updated = get_record(db, "articles", article["id"])
        assert updated["publishStatus"] == "failed"
        assert updated["publicationStatus"] == "failed"
        assert updated["errorMessage"] == "CMS connection failed"

def test_media_backlink_task_failure_releases_article_for_retry():
    with SessionLocal() as db:
        article = save_record(db, "articles", {
            "id": "article-media-failed",
            "title": "Media failure retry",
            "status": "ready",
            "publishStatus": "pending",
            "publicationStatus": "pending",
        })
        order = save_record(db, "mediaOrders", {
            "id": "media-order-failed",
            "articleId": article["id"],
            "articleTitle": article["title"],
            "status": "pending",
        })
        executor = TaskExecutor(db, MemoryQueueClient(), llm_generator=lambda context: {})

        executor._mark_source_failed({
            "type": "media-backlink-index",
            "payload": {"orderId": order["id"]},
        }, "Media publication failed")

        updated_article = get_record(db, "articles", article["id"])
        updated_order = get_record(db, "mediaOrders", order["id"])
        assert updated_article["publishStatus"] == "failed"
        assert updated_article["publicationStatus"] == "failed"
        assert updated_order["status"] == "failed"
        assert updated_order["errorMessage"] == "Media publication failed"
