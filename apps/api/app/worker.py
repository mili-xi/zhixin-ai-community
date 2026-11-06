from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from pathlib import Path

from .auth.context import ActorContext, actor_scope, current_owner_id
from . import app_time
from .database import Record
from .knowledge import build_chunk_records, extract_text_from_file, extract_text_from_url
from .credential_health import credential_validation_is_due, next_credential_check_at
from .desktop_channels import (
    desktop_command_target_device_is_live,
    desktop_device_is_live,
    desktop_supports_asset_cleanup,
    point_media_account_binding_at_device,
    resolve_media_account_channel_device,
)
from .queue import QueueClient, queue_client
from .search_index_provider import SearchIndexService
from .seo_provider import DataForSeoProvider, HttpSeoProvider, SeoProvider


def _default_seo_provider() -> SeoProvider:
    """Return DataForSeoProvider if credentials are configured, else HttpSeoProvider."""
    from .config import get_settings
    s = get_settings()
    if s.dataforseo_login and s.dataforseo_password:
        return DataForSeoProvider(login=s.dataforseo_login, password=s.dataforseo_password)
    return HttpSeoProvider()
from .service import (
    audit_event,
    build_writer_context,
    check_submission,
    create_ai_article,
    create_article,
    create_index_submission,
    create_llm_request_record,
    create_notification,
    create_publish_job,
    create_task,
    desktop_asset_cleanup_keep_profile_keys,
    find_record,
    get_record,
    list_canonical_media_accounts,
    list_records,
    log_task_event,
    make_id,
    media_order_account_id,
    media_order_image_publication_evidence_is_verified,
    media_order_requires_image_publication_evidence,
    patch_record,
    persist_knowledge_analysis,
    parse_desktop_command_timestamp,
    PUBLICATION_DISCOVERY_PLATFORMS,
    publication_discovery_required,
    publish_media_backlink,
    queue_article_media_publish_command,
    queue_media_publication_discovery,
    save_record,
    submit_index_submission,
    sync_auto_publish_task_status,
    verify_media_order_publication,
)
from .llm import build_deepseek_request_payload, generate_article_with_deepseek, repair_article_with_deepseek
from .config import Settings, get_settings
from .gemini import GeminiClient
from .step_image import StepImageClient
from .illustrated_content import (
    assemble_markdown,
    build_content_blocks,
    evaluate_article_quality,
    normalize_article_output,
    plan_required_images,
)


def _article_body_chars(article: dict[str, Any]) -> int:
    sections = article.get("sections") or []
    section_chars = 0
    for section in sections:
        if not isinstance(section, dict):
            continue
        section_chars += len(str(section.get("content") or "").replace(" ", "").replace("\n", ""))
    if section_chars >= 80:
        return section_chars
    markdown = str(article.get("contentMarkdown") or "")
    # Rough body length without markdown headings / image tags.
    cleaned = "\n".join(
        line for line in markdown.splitlines()
        if line.strip() and not line.strip().startswith("#") and not line.strip().startswith("![")
    )
    return len(cleaned.replace(" ", "").replace("\n", ""))


def list_value(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def first_list(provider_result: dict[str, Any], keys: list[str]) -> list[Any]:
    for key in keys:
        value = provider_result.get(key)
        if isinstance(value, list):
            return value
    return []


def publication_discovery_is_due(order: dict, now: datetime | None = None, retry_seconds: int = 900) -> bool:
    last_run = app_time.parse_stored_timestamp(order.get("lastPublicDiscoveryAt"))
    if last_run is None:
        return True
    current = now or datetime.now(last_run.tzinfo)
    if current.tzinfo is None:
        current = current.replace(tzinfo=last_run.tzinfo)
    else:
        current = current.astimezone(last_run.tzinfo)
    return (current - last_run).total_seconds() >= retry_seconds


def inclusion_verification_is_due(
    submission: dict,
    now: datetime | None = None,
    retry_seconds: int = 21600,
) -> bool:
    # A missing or unreadable stamp counts as never checked, which is why the
    # helper reports "due" rather than raising.
    checked_at = app_time.parse_stored_timestamp(submission.get("checkedAt"))
    if checked_at is None:
        return True
    current = now or datetime.now(checked_at.tzinfo)
    if current.tzinfo is None:
        current = current.replace(tzinfo=checked_at.tzinfo)
    else:
        current = current.astimezone(checked_at.tzinfo)
    return (current - checked_at).total_seconds() >= retry_seconds


def _media_recheck_settings() -> tuple[float, float, int]:
    from .config import get_settings

    settings = get_settings()
    base = max(float(getattr(settings, "media_recheck_backoff_base_seconds", 900.0) or 0.0), 0.0)
    ceiling = max(float(getattr(settings, "media_recheck_backoff_max_seconds", 86400.0) or 0.0), base)
    max_attempts = max(int(getattr(settings, "media_recheck_max_attempts", 40) or 0), 0)
    return base, ceiling, max_attempts


def media_publication_recheck_backoff_seconds(public_check_count: int) -> float:
    """Exponential delay before the next recheck of an unverified publication.

    The first couple of checks stay tight so a platform that publishes within
    minutes is still caught quickly; after that the delay doubles on every failed
    check up to the configured ceiling.
    """
    base, ceiling, _ = _media_recheck_settings()
    attempts = max(int(public_check_count or 0), 0)
    if attempts <= 1 or base <= 0:
        return 0.0
    return min(base * (2 ** min(attempts - 1, 20)), ceiling)


def media_publication_recheck_is_due(order: dict, now: datetime | None = None) -> bool:
    """Whether a review_required order should be rechecked again right now.

    Returns False while the order sits inside its backoff window, and False
    permanently once it has burned through the attempt cap, so a dead public page
    stops costing a browser launch every scheduler tick.
    """
    attempts = int(order.get("publicCheckCount") or 0)
    _, _, max_attempts = _media_recheck_settings()
    if max_attempts and attempts >= max_attempts:
        return False
    backoff = media_publication_recheck_backoff_seconds(attempts)
    if backoff <= 0:
        return True
    last_check = app_time.parse_stored_timestamp(order.get("publicCheckAt"))
    if last_check is None:
        return True
    current = now or datetime.now(last_check.tzinfo)
    if current.tzinfo is None:
        current = current.replace(tzinfo=last_check.tzinfo)
    else:
        current = current.astimezone(last_check.tzinfo)
    return (current - last_check).total_seconds() >= backoff


def media_publication_recheck_is_exhausted(order: dict) -> bool:
    attempts = int(order.get("publicCheckCount") or 0)
    _, _, max_attempts = _media_recheck_settings()
    return bool(max_attempts) and attempts >= max_attempts


class TaskExecutor:
    def __init__(
        self,
        db: Session,
        queue: QueueClient | Any = queue_client,
        url_fetcher: Callable[[str], str] | None = None,
        llm_generator: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
        image_generator: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
        seo_provider: SeoProvider | Any | None = None,
        provider_factory: Callable[[str, str], SeoProvider | Any] | None = None,
        search_index_service: SearchIndexService | Any | None = None,
    ) -> None:
        self.db = db
        self.queue = queue
        self.url_fetcher = url_fetcher or extract_text_from_url
        settings = get_settings()
        gemini = GeminiClient(settings) if settings.gemini_api_key and not settings.gemini_offline_mode else None
        step_image = StepImageClient(settings) if settings.article_image_provider == "step" and settings.step_api_key else None
        use_gemini_text = settings.article_text_provider == "gemini" and gemini is not None
        self.llm_generator = llm_generator or (gemini.generate_article if use_gemini_text else generate_article_with_deepseek)
        self.image_generator = image_generator or (step_image.generate_image if step_image else gemini.generate_image if gemini else None)
        self.image_provider = "custom" if image_generator else "stepfun" if step_image else "gemini" if gemini else "unconfigured"
        self.llm_provider = "deepseek" if llm_generator else "gemini" if use_gemini_text else "deepseek"
        self.seo_provider = seo_provider or _default_seo_provider()
        self.provider_factory = provider_factory or (lambda base_url, api_key: HttpSeoProvider(base_url=base_url, api_key=api_key))
        self.search_index_service = search_index_service or SearchIndexService()

    def list_kind(self, kind: str) -> list[dict]:
        return list_records(self.db, kind)

    def get_kind(self, kind: str, record_id: str) -> dict:
        return get_record(self.db, kind, record_id)

    def task_notification_target(self, task: dict, task_id: str, result: dict | None = None) -> dict:
        target = {"type": "task", "taskId": task_id, "taskType": task.get("type"), "queue": task.get("queue")}
        if not isinstance(result, dict):
            return target
        business_keys = [
            "articleId",
            "knowledgeId",
            "indexSubmissionId",
            "mediaOrderId",
            "publishJobId",
            "llmRequestId",
            "autoPublishTaskId",
            "autoGeoTaskId",
            "providerResultId",
            "recordId",
            "recordKind",
        ]
        for key in business_keys:
            value = result.get(key)
            if value:
                target[key] = value
        if result.get("submissionId") and not target.get("indexSubmissionId"):
            target["indexSubmissionId"] = result["submissionId"]
        article_ids = result.get("generatedArticleIds")
        if not target.get("articleId") and isinstance(article_ids, list) and article_ids:
            target["articleId"] = article_ids[0]
        return target

    def _queued_task_actor(self, task_id: str, queued_owner_id: str = "") -> tuple[ActorContext | None, str]:
        row = self.db.get(Record, task_id)
        if row is None or row.kind != "tasks" or not row.owner_id:
            return None, "TASK_OWNER_NOT_FOUND"
        actual_owner_id = str(row.owner_id)
        if queued_owner_id and queued_owner_id != actual_owner_id:
            return None, "QUEUE_OWNER_MISMATCH"
        return ActorContext.system_worker(actual_owner_id), ""

    def run_next(self, queues: list[str], timeout: int = 5) -> dict | None:
        reserve = getattr(self.queue, "reserve", None)
        if not callable(reserve):
            message = self.queue.pop(queues, timeout=timeout)
            if not message:
                return None
            _, payload = message
            task_id = str(payload.get("taskId") or "")
            if not task_id:
                return None
            actor, owner_error = self._queued_task_actor(task_id, str(payload.get("ownerId") or ""))
            if owner_error:
                return {"status": "failed", "errorMessage": owner_error}
            with actor_scope(actor):
                return self.run_task(task_id)

        message = reserve(queues, timeout=timeout)
        if not message:
            return None
        task_id = str(message.payload.get("taskId") or "")
        if not task_id:
            self.queue.nack(message, "QUEUE_TASK_ID_MISSING", retryable=False)
            return {"status": "failed", "errorMessage": "QUEUE_TASK_ID_MISSING"}
        actor, owner_error = self._queued_task_actor(task_id, str(message.payload.get("ownerId") or ""))
        if owner_error:
            self.queue.nack(message, owner_error, retryable=False)
            return {"status": "failed", "errorMessage": owner_error}
        try:
            with actor_scope(actor):
                result = self.run_task(task_id)
        except Exception as error:
            self.db.rollback()
            self.queue.nack(message, str(error))
            return {"status": "failed", "errorMessage": str(error)}
        if result.get("status") in {"succeeded", "canceled", "cancelled"} or result.get("queueTerminal"):
            acknowledged = self.queue.ack(message)
            if not acknowledged:
                log_task_event(
                    self.db,
                    task_id,
                    "queue.ack_failed",
                    "Task succeeded, but the queue acknowledgement was not persisted; the lease will allow safe recovery.",
                    level="warning",
                    detail={"queue": message.queue, "messageId": message.message_id},
                )
                audit_event(
                    self.db,
                    "queue.ack_failed",
                    "tasks",
                    task_id,
                    {"queue": message.queue, "messageId": message.message_id},
                )
        else:
            self.queue.nack(message, str(result.get("errorMessage") or "TASK_FAILED"))
        return result
    def run_task(self, task_id: str) -> dict:
        task = get_record(self.db, "tasks", task_id)
        if task.get("status") in {"succeeded", "canceled", "cancelled"} or task.get("queueTerminal"):
            return task
        patch_record(self.db, "tasks", task_id, {"status": "running", "progress": 10})
        log_task_event(self.db, task_id, "task.started", f"Worker started {task.get('type')}")
        try:
            result = self.dispatch(task)
            updated = patch_record(self.db, "tasks", task_id, {
                "status": "succeeded",
                "progress": 100,
                "stage": result.get("stage") if isinstance(result, dict) and result.get("stage") else "complete",
                "result": result,
                "errorMessage": "",
            })
            log_task_event(self.db, task_id, "task.succeeded", "Task completed", detail={"result": result})
            audit_event(self.db, "task.succeeded", "tasks", task_id, {"type": task.get("type")})
            create_notification(
                self.db,
                "Task completed",
                f"{task.get('title') or task.get('type')} completed successfully",
                "success",
                self.task_notification_target(task, task_id, result),
            )
            return updated
        except Exception as error:
            updated = patch_record(self.db, "tasks", task_id, {"status": "failed", "stage": "failed", "errorMessage": str(error)})
            log_task_event(self.db, task_id, "task.failed", str(error), level="error")
            audit_event(self.db, "task.failed", "tasks", task_id, {"type": task.get("type"), "error": str(error)})
            self._mark_source_failed(task, str(error))
            create_notification(
                self.db,
                "Task failed",
                f"{task.get('title') or task.get('type')} failed: {error}",
                "error",
                {"type": "task", "taskId": task_id, "taskType": task.get("type"), "queue": task.get("queue")},
            )
            return updated

    def _mark_source_failed(self, task: dict, error_message: str) -> None:
        """Write failure state back to business records so UI is not stuck on queued."""
        task_type = str(task.get("type") or "")
        payload = task.get("payload") if isinstance(task.get("payload"), dict) else {}
        if task_type == "publish-and-index":
            article_id = str(payload.get("articleId") or "")
            publish_job_id = str(payload.get("publishJobId") or "")
            if publish_job_id and find_record(self.db, "publishJobs", publish_job_id):
                patch_record(self.db, "publishJobs", publish_job_id, {
                    "status": "failed",
                    "errorMessage": error_message,
                    "updatedAt": app_time.now_stamp(),
                })
            if article_id and find_record(self.db, "articles", article_id):
                patch_record(self.db, "articles", article_id, {
                    "publishStatus": "failed",
                    "publicationStatus": "failed",
                    "errorMessage": error_message,
                    "updatedAt": app_time.now_stamp(),
                })
            return
        if task_type == "media-backlink-index":
            order_id = str(payload.get("orderId") or "")
            order = find_record(self.db, "mediaOrders", order_id) if order_id else None
            if order:
                patch_record(self.db, "mediaOrders", order_id, {
                    "status": "failed",
                    "backlinkStatus": "failed",
                    "errorMessage": error_message,
                    "updatedAt": app_time.now_stamp(),
                })
                article_id = str(order.get("articleId") or "")
                if article_id and find_record(self.db, "articles", article_id):
                    patch_record(self.db, "articles", article_id, {
                        "publishStatus": "failed",
                        "publicationStatus": "failed",
                        "mediaPublishStatus": "failed",
                        "errorMessage": error_message,
                        "updatedAt": app_time.now_stamp(),
                    })
            return
        if task_type in {"knowledge-fetch-url", "knowledge-upload-parse", "knowledge-refresh"}:
            knowledge_id = str(payload.get("knowledgeId") or payload.get("recordId") or "")
            if knowledge_id and find_record(self.db, "knowledgeItems", knowledge_id):
                patch_record(self.db, "knowledgeItems", knowledge_id, {
                    "status": "failed",
                    "errorMessage": error_message,
                    "updatedAt": app_time.now_stamp(),
                })
            return
        if task_type == "serp-collect":
            record_id = str(payload.get("recordId") or "")
            if record_id and find_record(self.db, "serpAnalyses", record_id):
                patch_record(self.db, "serpAnalyses", record_id, {
                    "status": "failed",
                    "errorMessage": error_message,
                    "contentBrief": f"SERP 采集失败：{error_message}",
                    "updatedAt": app_time.now_stamp(),
                })

    def dispatch(self, task: dict) -> dict:
        task_type = str(task.get("type") or "")
        payload = task.get("payload") if isinstance(task.get("payload"), dict) else {}
        payload = {**payload, "taskId": task.get("id")}
        if task_type == "knowledge-upload-parse":
            return self.execute_knowledge_upload_parse(payload)
        if task_type == "knowledge-fetch-url":
            return self.execute_knowledge_fetch(payload)
        if task_type == "index-submit":
            return self.execute_index_submit(payload)
        if task_type == "inclusion-check":
            return self.execute_inclusion_check(payload)
        if task_type == "ai-generate-article":
            return self.execute_ai_generation(payload)
        if task_type == "auto-geo-rewrite":
            return self.execute_auto_geo_rewrite(payload)
        if task_type == "auto-publish":
            return self.execute_auto_publish(payload)
        if task_type == "publish-and-index":
            return self.execute_publish_and_index(payload)
        if task_type == "media-backlink-index":
            return self.execute_media_backlink_index(payload)
        if task_type == "media-publication-recheck":
            return self.execute_media_publication_recheck(payload)
        if task_type in {"keyword-discover", "serp-collect", "geo-collect", "ranking-check"}:
            return self.execute_seo_collection(task_type, payload)
        return {"skipped": True, "type": task_type}

    def execute_knowledge_fetch(self, payload: dict) -> dict:
        url = str(payload.get("url") or "")
        knowledge_id = str(payload.get("knowledgeId") or payload.get("recordId") or "")
        if not knowledge_id:
            current = save_record(self.db, "knowledgeItems", {"title": url, "source": "url", "url": url, "status": "fetching"})
        else:
            current = get_record(self.db, "knowledgeItems", knowledge_id)
            if current.get("status") != "fetching":
                patch_record(self.db, "knowledgeItems", current["id"], {"status": "learning", "errorMessage": "", "updatedAt": app_time.now_stamp()})
        # url_fetcher defaults to knowledge.extract_text_from_url (Scrapling-first pipeline).
        text = self.url_fetcher(url)
        chunks, vectors = build_chunk_records(current["id"], text)
        updated = persist_knowledge_analysis(self.db, current, text, {"id": payload.get("taskId") or ""}, chunks, vectors)
        return {"knowledgeId": updated["id"], "chunkCount": updated.get("chunkCount", 0), "vectorCount": updated.get("vectorCount", 0)}

    def execute_knowledge_upload_parse(self, payload: dict) -> dict:
        knowledge_id = str(payload.get("knowledgeId") or payload.get("recordId") or "")
        path = Path(str(payload.get("path") or ""))
        if not knowledge_id:
            raise ValueError("knowledgeId is required")
        if not path:
            raise ValueError("path is required")
        current = get_record(self.db, "knowledgeItems", knowledge_id)
        text = extract_text_from_file(path, str(payload.get("contentType") or current.get("contentType") or ""))
        chunks, vectors = build_chunk_records(current["id"], text)
        updated = persist_knowledge_analysis(self.db, current, text, {"id": payload.get("taskId") or ""}, chunks, vectors)
        return {"knowledgeId": updated["id"], "chunkCount": updated.get("chunkCount", 0), "vectorCount": updated.get("vectorCount", 0)}

    def execute_inclusion_check(self, payload: dict) -> dict:
        submission_id = str(payload.get("submissionId") or payload.get("recordId") or "")
        if not submission_id:
            raise ValueError("submissionId is required")
        submission = check_submission(self.db, submission_id, self.search_index_service)
        return {
            "submissionId": submission["id"],
            "inclusionStatus": submission.get("inclusionStatus"),
            "verificationLevel": submission.get("verificationLevel"),
            "verificationMethod": submission.get("verificationMethod"),
        }

    def execute_index_submit(self, payload: dict) -> dict:
        submission_id = str(payload.get("submissionId") or "")
        if submission_id:
            submission = get_record(self.db, "indexSubmissions", submission_id)
        else:
            url = str(payload.get("url") or "")
            article_id = str(payload.get("articleId") or "")
            if not url:
                raise ValueError("url is required")
            submission = create_index_submission(self.db, {
                "articleId": article_id,
                "articleTitle": payload.get("articleTitle") or payload.get("title") or "",
                "provider": payload.get("provider") or "IndexNow",
                "source": payload.get("source") or "worker-index-submit",
                "sourceType": payload.get("sourceType") or "manual",
                "sourceId": payload.get("sourceId") or article_id,
                "url": url,
            })
        submission = submit_index_submission(self.db, submission["id"], self.search_index_service)
        if payload.get("checkImmediately"):
            submission = check_submission(self.db, submission["id"], self.search_index_service)
        return {
            "indexSubmissionId": submission["id"],
            "url": submission.get("url"),
            "provider": submission.get("provider"),
            "status": submission.get("status"),
            "submitted": submission.get("submitted"),
            "inclusionStatus": submission.get("inclusionStatus"),
            "verificationLevel": submission.get("verificationLevel"),
        }

    def execute_ai_generation(self, payload: dict) -> dict:
        if payload.get("articleId"):
            return {"articleId": payload["articleId"], "alreadyCreated": True}
        task_id = str(payload.get("taskId") or "")
        patch_record(self.db, "tasks", task_id, {"progress": 10, "stage": "context"})
        context = build_writer_context(self.db, payload)
        patch_record(self.db, "tasks", task_id, {"progress": 30, "stage": "writing"})
        if self.llm_provider == "gemini":
            settings = get_settings()
            request_payload = {
                "provider": "gemini",
                "model": payload.get("model") or settings.gemini_text_model,
                "contextSummary": {"keyword": context.get("keyword") or ""},
            }
        else:
            request_payload = build_deepseek_request_payload(context, payload.get("model"))
        try:
            output = self.llm_generator(context)
        except Exception as error:
            create_llm_request_record(
                self.db,
                context,
                request_payload,
                {},
                task_id=task_id,
                status="failed",
                error_message=str(error),
                provider=self.llm_provider,
            )
            raise
        max_inline = int(payload.get("maxInlineImages") or 5)
        raw_output = output
        normalized = normalize_article_output(output, max_inline)
        # Skeleton-only drafts (titles + empty sections) get one repair pass.
        if _article_body_chars(normalized) < 200:
            patch_record(self.db, "tasks", task_id, {"progress": 40, "stage": "rewrite_body"})
            try:
                if self.llm_provider == "deepseek" or self.llm_generator is generate_article_with_deepseek:
                    repaired = repair_article_with_deepseek(context, normalized)
                else:
                    repaired = self.llm_generator({**context, "forceFullBody": True, "previousDraft": normalized})
                if isinstance(repaired, dict):
                    repaired_normalized = normalize_article_output(repaired, max_inline)
                    if _article_body_chars(repaired_normalized) > _article_body_chars(normalized):
                        output = repaired
                        normalized = repaired_normalized
            except Exception as repair_error:
                log_task_event(
                    self.db,
                    task_id,
                    "ai_generation_body_repair_failed",
                    str(repair_error),
                    level="warning",
                )
        patch_record(self.db, "tasks", task_id, {"progress": 50, "stage": "draft"})
        article = create_ai_article(
            self.db,
            payload,
            normalized,
            context,
            create_generation_task=False,
            task_id=task_id,
            request_payload=request_payload,
            provider=self.llm_provider,
            audit_output=raw_output,
        )
        body_chars = _article_body_chars(normalized)
        if not payload.get("generateImages") or body_chars < 80:
            # No body → skip expensive Step 配图; force review so editor shows the empty-body banner.
            quality = evaluate_article_quality(normalized, [], "none" if not payload.get("generateImages") else "cover-and-inline")
            if body_chars < 80 and "CONTENT_TOO_SHORT" not in quality.get("issues", []):
                quality = {
                    **quality,
                    "status": "review_required",
                    "issues": [*quality.get("issues", []), "CONTENT_TOO_SHORT", "EMPTY_SECTION_BODY"],
                }
            article = patch_record(self.db, "articles", article["id"], {
                "sections": normalized.get("sections") or [],
                "contentMarkdown": normalized.get("contentMarkdown") or article.get("contentMarkdown"),
                "contentBlocks": build_content_blocks(normalized, []),
                "imageBriefs": normalized.get("imageBriefs") or [],
                "imageGenerationStatus": "disabled" if not payload.get("generateImages") else "failed",
                "imageErrors": [] if body_chars >= 80 else [{
                    "code": "EMPTY_SECTION_BODY",
                    "message": "正文为空，已跳过配图。请重新生成，确保每节有完整段落。",
                }],
                "quality": quality,
                "status": quality["status"],
            })
            return {
                "articleId": article["id"],
                "assetIds": [],
                "imageSucceeded": 0,
                "imageFailed": 0 if body_chars >= 80 else 1,
                "quality": quality,
                "stage": "complete",
            }

        image_strategy = str(payload.get("imageStrategy") or (context.get("rule") or {}).get("imageStrategy") or "cover-and-inline")
        plan = plan_required_images(normalized, context.get("assets") or [], image_strategy, int(payload.get("maxInlineImages") or 5))
        images: list[dict[str, Any]] = []
        errors: list[dict[str, Any]] = []
        for index, item in enumerate(plan):
            patch_record(self.db, "tasks", task_id, {
                "progress": min(85, 70 + round((index / max(1, len(plan))) * 15)),
                "stage": "images",
            })
            if item.get("action") == "reuse":
                asset = item.get("asset") or {}
                images.append({
                    "assetId": asset.get("id"),
                    "purpose": item.get("purpose"),
                    "sectionId": item.get("sectionId") or "",
                    "url": asset.get("url") or "",
                    "path": asset.get("path") or "",
                    "altText": item.get("altText") or asset.get("altText") or "",
                    "source": asset.get("source") or "upload",
                })
                continue
            if not self.image_generator:
                errors.append({
                    "briefId": item.get("id") or "",
                    "purpose": item.get("purpose") or "inline",
                    "sectionId": item.get("sectionId") or "",
                    "code": "IMAGE_PROVIDER_NOT_CONFIGURED",
                    "message": "图片模型尚未配置或不可用（默认 Step Image Edit 2，请检查 STEP_API_KEY）",
                })
                continue
            try:
                generated = self.image_generator(item)
                images.append(self._persist_generated_image(article["id"], task_id, item, generated))
            except Exception as error:
                errors.append({
                    "briefId": item.get("id") or "",
                    "purpose": item.get("purpose") or "inline",
                    "sectionId": item.get("sectionId") or "",
                    "code": str(getattr(error, "code", "IMAGE_GENERATION_FAILED")),
                    "message": str(error),
                })

        patch_record(self.db, "tasks", task_id, {"progress": 95, "stage": "quality"})
        quality = evaluate_article_quality(normalized, images, image_strategy)
        if errors:
            quality = {**quality, "status": "review_required", "issues": [*quality.get("issues", []), "IMAGE_GENERATION_PARTIAL"]}
        cover = next((image for image in images if image.get("purpose") == "cover"), None)
        inline_images = [image for image in images if image.get("purpose") != "cover"]
        article = patch_record(self.db, "articles", article["id"], {
            "contentMarkdown": assemble_markdown(normalized, images),
            "contentBlocks": build_content_blocks(normalized, images),
            "sections": normalized.get("sections") or [],
            "imageBriefs": normalized.get("imageBriefs") or [],
            "coverImage": cover,
            "inlineImages": inline_images,
            "assetIds": [image.get("assetId") for image in images if image.get("assetId")],
            "imageGenerationStatus": "partial" if errors and images else "failed" if errors else "completed",
            "imageErrors": errors,
            "quality": quality,
            "status": quality["status"],
        })
        return {
            "articleId": article["id"],
            "assetIds": article.get("assetIds") or [],
            "imageSucceeded": len(images),
            "imageFailed": len(errors),
            "quality": quality,
            "stage": "complete",
        }

    def _persist_generated_image(self, article_id: str, task_id: str, brief: dict, generated: dict) -> dict:
        data = generated.get("data")
        if not isinstance(data, bytes) or not data:
            raise ValueError("GEMINI_EMPTY_IMAGE")
        mime_type = str(generated.get("mimeType") or "image/png")
        extension = {"image/jpeg": ".jpg", "image/webp": ".webp"}.get(mime_type, ".png")
        settings = Settings()
        upload_dir = Path(settings.upload_dir)
        if not upload_dir.is_absolute():
            upload_dir = Path.cwd() / upload_dir
        asset_dir = upload_dir / "assets"
        asset_dir.mkdir(parents=True, exist_ok=True)
        asset_id = make_id("assets")
        filename = f"{asset_id}-{brief.get('purpose') or 'image'}{extension}"
        target = asset_dir / filename
        target.write_bytes(data)
        asset = save_record(self.db, "assets", {
            "id": asset_id,
            "filename": filename,
            "type": "cover" if brief.get("purpose") == "cover" else "inline",
            "source": "ai",
            "provider": generated.get("provider") or self.image_provider,
            "model": generated.get("model") or get_settings().gemini_image_model,
            "contentType": mime_type,
            "path": str(target),
            "url": f"/uploads/assets/{filename}",
            "altText": brief.get("altText") or "文章配图",
            "prompt": brief.get("prompt") or "",
            "purpose": brief.get("purpose") or "inline",
            "sectionId": brief.get("sectionId") or "",
            "relatedArticle": article_id,
            "articleId": article_id,
            "taskId": task_id,
            "tags": ["AI配图", str(brief.get("purpose") or "inline")],
            "sizeBytes": len(data),
            "size": f"{len(data)} B",
            "createdAt": app_time.now_stamp(),
            "updatedAt": app_time.now_stamp(),
        })
        return {
            "assetId": asset["id"],
            "purpose": brief.get("purpose") or "inline",
            "sectionId": brief.get("sectionId") or "",
            "url": asset["url"],
            "path": asset["path"],
            "altText": asset["altText"],
            "source": "ai",
        }

    def execute_auto_publish(self, payload: dict) -> dict:
        keywords = [str(item).strip() for item in payload.get("selectedKeywords") or payload.get("keywords") or [] if str(item).strip()]
        requested_article_ids = payload.get("articleIds") or ([payload.get("articleId")] if payload.get("articleId") else [])
        article_ids = []
        generated_article_ids = []
        for article_id in requested_article_ids:
            article = get_record(self.db, "articles", str(article_id))
            if article["id"] not in article_ids:
                article_ids.append(article["id"])
        media_account_ids = [str(item).strip() for item in payload.get("mediaAccountIds") or [] if str(item).strip()]
        auto_publish_task_id = str(payload.get("autoPublishTaskId") or "")
        task_id = str(payload.get("taskId") or "")
        total = len(article_ids) + len(keywords)
        if auto_publish_task_id and find_record(self.db, "autoPublishTasks", auto_publish_task_id):
            patch_record(self.db, "autoPublishTasks", auto_publish_task_id, {
                "status": "running",
                "taskId": task_id,
                "publishCount": total,
                "articleIds": article_ids,
                "mediaAccountIds": media_account_ids,
                "successCount": 0,
                "failedCount": 0,
                "lastError": "",
            })
        for keyword in keywords:
            try:
                article_payload = {
                    "keyword": keyword,
                    "status": "ready",
                    "ruleId": payload.get("ruleId") or "",
                    "ruleName": payload.get("ruleName") or "",
                    "knowledgeIds": payload.get("knowledgeIds") or [],
                    "assetIds": payload.get("assetIds") or [],
                    "tags": ["auto-publish"],
                    "writerContext": {
                        "source": "auto-publish",
                        "autoPublishTaskId": auto_publish_task_id,
                        "batchName": payload.get("name") or payload.get("taskName") or "",
                        "scheduleMode": payload.get("scheduleMode") or "",
                        "targetChannels": payload.get("targetChannels") or [f"media:{account_id}" for account_id in media_account_ids],
                        "targetMedia": media_account_ids,
                        "publishWindow": payload.get("publishWindow") or payload.get("scheduleWindow") or {},
                        "watermarkId": payload.get("watermarkId") or "",
                    },
                }
                context = build_writer_context(self.db, article_payload)
                request_payload = build_deepseek_request_payload(context, payload.get("model"))
                output = self.llm_generator(context)
                article = create_ai_article(
                    self.db,
                    article_payload,
                    output,
                    context,
                    create_generation_task=False,
                    task_id=task_id,
                    request_payload=request_payload,
                )
                article_ids.append(article["id"])
                generated_article_ids.append(article["id"])
                if task_id:
                    progress = 10 + int((len(article_ids) / max(total, 1)) * 60)
                    patch_record(self.db, "tasks", task_id, {"progress": min(progress, 75)})
                if auto_publish_task_id and find_record(self.db, "autoPublishTasks", auto_publish_task_id):
                    patch_record(self.db, "autoPublishTasks", auto_publish_task_id, {
                        "articleIds": article_ids,
                        "generatedArticleIds": generated_article_ids,
                        "successCount": len(article_ids),
                        "failedCount": 0,
                    })
            except Exception as error:
                if "context" in locals() and "request_payload" in locals():
                    create_llm_request_record(
                        self.db,
                        context,
                        request_payload,
                        {},
                        task_id=task_id,
                        status="failed",
                        error_message=str(error),
                    )
                if auto_publish_task_id and find_record(self.db, "autoPublishTasks", auto_publish_task_id):
                    patch_record(self.db, "autoPublishTasks", auto_publish_task_id, {
                        "status": "failed",
                        "articleIds": article_ids,
                        "generatedArticleIds": generated_article_ids,
                        "successCount": len(article_ids),
                        "failedCount": max(total - len(article_ids), 1),
                        "lastError": str(error),
                    })
                raise

        desktop_command_ids = []
        should_publish = bool(media_account_ids) and payload.get("scheduleMode") != "manual"
        if should_publish:
            for article_id in article_ids:
                article = get_record(self.db, "articles", article_id)
                for account_id in media_account_ids:
                    dedupe_key = f"{auto_publish_task_id}:{article_id}:{account_id}"
                    try:
                        queued = queue_article_media_publish_command(
                            self.db,
                            article,
                            account_id,
                            {
                                **payload,
                                "autoPublishTaskId": auto_publish_task_id,
                                "dedupeKey": dedupe_key,
                                "attempt": 1,
                                "confirmPublish": payload.get("confirmPublish", True) is not False,
                                "publishMode": "publish",
                            },
                            source="auto-publish",
                        )
                        command_id = queued["command"]["id"]
                    except Exception as error:
                        failed_command = save_record(self.db, "desktopCommands", {
                            "id": make_id("desktopCommands"),
                            "deviceId": "",
                            "type": "publish_article",
                            "mediaAccountId": account_id,
                            "payload": {
                                "articleId": article_id,
                                "articleTitle": article.get("title") or "未命名文章",
                                "autoPublishTaskId": auto_publish_task_id,
                                "dedupeKey": dedupe_key,
                                "attempt": 1,
                                "confirmPublish": payload.get("confirmPublish", True) is not False,
                                "publishMode": "publish",
                                "provider": payload.get("provider") or "",
                                "checkImmediately": bool(payload.get("checkImmediately")),
                            },
                            "status": "failed",
                            "result": {},
                            "errorMessage": str(error),
                            "createdAt": app_time.now_stamp(),
                            "updatedAt": app_time.now_stamp(),
                        })
                        command_id = failed_command["id"]
                    if command_id not in desktop_command_ids:
                        desktop_command_ids.append(command_id)
            if task_id:
                patch_record(self.db, "tasks", task_id, {"progress": 95})
        if auto_publish_task_id and find_record(self.db, "autoPublishTasks", auto_publish_task_id):
            updated_batch = patch_record(self.db, "autoPublishTasks", auto_publish_task_id, {
                "status": "publishing" if desktop_command_ids else "succeeded",
                "articleIds": article_ids,
                "generatedArticleIds": generated_article_ids,
                "desktopCommandIds": desktop_command_ids,
                "queuedPublishCount": len(desktop_command_ids),
                "publishPendingCount": len(desktop_command_ids),
                "publishSucceededCount": 0,
                "publishFailedCount": 0,
                "successCount": len(article_ids),
                "failedCount": 0,
            })
            if desktop_command_ids:
                updated_batch = sync_auto_publish_task_status(self.db, auto_publish_task_id) or updated_batch
        return {
            "autoPublishTaskId": auto_publish_task_id,
            "articleIds": article_ids,
            "generatedArticleIds": generated_article_ids,
            "desktopCommandIds": desktop_command_ids,
            "queuedPublishCount": len(desktop_command_ids),
            "count": len(article_ids),
        }

    def execute_auto_geo_rewrite(self, payload: dict) -> dict:
        question_ids = [str(item) for item in payload.get("questionIds") or []]
        questions = [item for item in (find_record(self.db, "geoQuestions", question_id) for question_id in question_ids) if item]
        article_ids = []
        for question in questions:
            keyword = question.get("keyword") or question.get("question") or "GEO rewrite"
            article_payload = {
                "keyword": keyword,
                "status": "ready",
                "ruleId": payload.get("ruleId") or "",
                "ruleName": payload.get("ruleName") or "Auto GEO rewrite",
                "knowledgeIds": payload.get("knowledgeIds") or [],
                "assetIds": payload.get("assetIds") or [],
                "tags": ["auto-geo", str(question.get("platform") or "").strip()],
                "writerContext": {
                    "source": "auto-geo",
                    "geoQuestionId": question["id"],
                    "title": f"{keyword} GEO rewrite",
                    "question": question.get("question") or "",
                    "platform": question.get("platform") or "",
                    "sourceMedia": question.get("sourceMedia") or "",
                    "sourceUrl": question.get("sourceUrl") or "",
                    "answerExcerpt": question.get("answerExcerpt") or "",
                    "brandMention": bool(question.get("brandMention")),
                    "competitorMention": bool(question.get("competitorMention")),
                    "targetPlatforms": payload.get("targetPlatforms") or [],
                },
            }
            context = build_writer_context(self.db, article_payload)
            request_payload = build_deepseek_request_payload(context, payload.get("model"))
            try:
                output = self.llm_generator(context)
            except Exception as error:
                create_llm_request_record(
                    self.db,
                    context,
                    request_payload,
                    {},
                    task_id=str(payload.get("taskId") or ""),
                    status="failed",
                    error_message=str(error),
                )
                raise
            article = create_ai_article(
                self.db,
                article_payload,
                output,
                context,
                create_generation_task=False,
                task_id=str(payload.get("taskId") or ""),
                request_payload=request_payload,
            )
            article_ids.append(article["id"])
            patch_record(self.db, "geoQuestions", question["id"], {
                "rewriteStatus": "draft_created",
                "rewriteArticleId": article["id"],
            })
        auto_geo_task_id = str(payload.get("autoGeoTaskId") or payload.get("autoPublishTaskId") or "")
        if auto_geo_task_id and find_record(self.db, "autoPublishTasks", auto_geo_task_id):
            patch_record(self.db, "autoPublishTasks", auto_geo_task_id, {
                "status": "succeeded",
                "generatedArticleIds": article_ids,
                "successCount": len(article_ids),
                "failedCount": max(0, len(question_ids) - len(article_ids)),
            })
        return {"autoGeoTaskId": auto_geo_task_id, "generatedArticleIds": article_ids, "count": len(article_ids)}

    def execute_publish_and_index(self, payload: dict) -> dict:
        from .cms_adapter import get_cms_adapter
        article = get_record(self.db, "articles", str(payload.get("articleId") or ""))
        site = get_record(self.db, "sites", str(payload.get("siteId") or ""))

        # Determine whether this site has a real CMS configured.
        # "configured" means: Webhook type with a webhookUrl, or WordPress type with credentials.
        site_type = str(site.get("type") or site.get("siteType") or "Webhook")
        has_real_cms = (
            (site_type == "WordPress" and bool(site.get("wpUsername") or site.get("wpAppPassword")))
            or (site_type == "Webhook" and bool(site.get("webhookUrl")))
        )

        published_url = ""
        external_id = ""
        adapter_type = ""
        task_id = str(payload.get("taskId") or "")

        if has_real_cms:
            # Real CMS configured: publish must succeed or the task fails.
            adapter = get_cms_adapter(site)
            adapter_type = adapter.adapter_type
            result = adapter.publish(article, site)  # raises on any failure
            published_url = str(result.get("publishedUrl") or "")
            if not published_url:
                raise ValueError(f"CMS adapter ({adapter_type}) returned no publishedUrl")
            external_id = str(result.get("externalId") or "")
            log_task_event(
                self.db, task_id, "cms.published",
                f"Published to {adapter_type}: {published_url}",
                detail={"adapterType": adapter_type, "publishedUrl": published_url, "externalId": external_id},
            )
        else:
            # No CMS configured yet: record a pending job without marking article published.
            adapter_type = site_type
            log_task_event(
                self.db, task_id, "cms.unconfigured",
                f"Site '{site.get('name')}' has no CMS endpoint configured; publish job recorded as pending.",
                level="warn",
            )

        job = create_publish_job(
            self.db, article, site,
            published_url=published_url,
            external_id=external_id,
            adapter_type=adapter_type,
        )

        if not published_url:
            return {"publishJobId": job["id"], "indexSubmissionId": "", "publishedUrl": ""}

        if payload.get("submitIndex") is not True:
            return {"publishJobId": job["id"], "indexSubmissionId": "", "publishedUrl": published_url}

        submission = create_index_submission(self.db, {
            "articleId": article["id"],
            "articleTitle": job["articleTitle"],
            "provider": payload.get("provider") or "IndexNow",
            "source": "worker-publish",
            "sourceType": "site",
            "sourceId": job["id"],
            "url": published_url,
        })
        submission = submit_index_submission(self.db, submission["id"], self.search_index_service)
        if payload.get("checkImmediately"):
            submission = check_submission(self.db, submission["id"], self.search_index_service)
        return {
            "publishJobId": job["id"],
            "indexSubmissionId": submission["id"],
            "publishedUrl": published_url,
            "indexStatus": submission.get("status"),
            "inclusionStatus": submission.get("inclusionStatus"),
        }

    def execute_media_backlink_index(self, payload: dict) -> dict:
        result = publish_media_backlink(self.db, payload, create_task_record=False)
        order = result["mediaOrder"]
        if payload.get("submitIndex") is not True or not result.get("indexSubmission"):
            return {
                "mediaOrderId": order["id"],
                "indexSubmissionId": "",
                "backlinkUrl": order.get("backlinkUrl"),
            }
        submission = submit_index_submission(self.db, result["indexSubmission"]["id"], self.search_index_service)
        if payload.get("checkImmediately"):
            submission = check_submission(self.db, submission["id"], self.search_index_service)
        return {
            "mediaOrderId": order["id"],
            "indexSubmissionId": submission["id"],
            "backlinkUrl": order.get("backlinkUrl"),
            "indexStatus": submission.get("status"),
            "inclusionStatus": submission.get("inclusionStatus"),
        }

    def execute_media_publication_recheck(self, payload: dict) -> dict:
        result = verify_media_order_publication(self.db, payload, url_fetcher=self.url_fetcher)
        order = result["mediaOrder"]
        submission = result.get("indexSubmission")
        response = {
            "mediaOrderId": order["id"],
            "verified": result.get("verified", False),
            "reason": result.get("reason", ""),
            "backlinkUrl": order.get("backlinkUrl", ""),
            "reviewUrl": order.get("reviewUrl", ""),
        }
        if submission:
            if payload.get("submitIndex") is not True:
                return response
            submission = submit_index_submission(self.db, submission["id"], self.search_index_service)
            if payload.get("checkImmediately"):
                submission = check_submission(self.db, submission["id"], self.search_index_service)
            response["indexSubmissionId"] = submission["id"]
            response["indexStatus"] = submission.get("status")
            response["inclusionStatus"] = submission.get("inclusionStatus")
        return response

    def execute_seo_collection(self, task_type: str, payload: dict) -> dict:
        record_id = str(payload.get("recordId") or "")
        provider_config_id = str(payload.get("providerConfigId") or "")
        provider_config = find_record(self.db, "seoProviderConfigs", provider_config_id) if provider_config_id else None
        provider = self.seo_provider
        if provider_config:
            provider_type = str(provider_config.get("provider") or "").lower()
            if provider_type == "dataforseo":
                # For DataForSEO configs: store login in baseUrl, password in apiKey
                login = str(provider_config.get("baseUrl") or "") or None
                password = str(provider_config.get("apiKey") or "") or None
                provider = DataForSeoProvider(login=login, password=password)
            else:
                provider = self.provider_factory(str(provider_config.get("baseUrl") or ""), str(provider_config.get("apiKey") or ""))
            payload = {
                **payload,
                "provider": provider_config.get("provider") or payload.get("provider") or "configured-provider",
                "providerConfigId": provider_config["id"],
            }
        kind_by_type = {
            "keyword-discover": "keywords",
            "serp-collect": "serpAnalyses",
            "geo-collect": "geoQuestions",
            "ranking-check": "rankingEntries",
        }
        kind = kind_by_type[task_type]
        record = get_record(self.db, kind, record_id) if record_id and find_record(self.db, kind, record_id) else None
        try:
            provider_result = provider.collect(task_type, payload)
        except Exception as error:
            collected_at = app_time.now_stamp()
            save_record(self.db, "seoProviderResults", {
                "taskId": payload.get("taskId") or "",
                "taskType": task_type,
                "recordKind": kind,
                "sourceRecordId": record["id"] if record else record_id,
                "providerConfigId": provider_config_id,
                "provider": payload.get("provider") or "configured-provider",
                "status": "failed",
                "requestPayload": payload,
                "response": {"errorMessage": str(error), "errorType": error.__class__.__name__},
                "createdAt": collected_at,
                "updatedAt": collected_at,
            })
            raise
        status = "provider_pending" if provider_result.get("status") == "provider_pending" else "collected"
        collected_at = app_time.now_stamp()
        pending_message = str(
            provider_result.get("message")
            or provider_result.get("providerMessage")
            or "SEO 数据源未配置或暂不可用，无法拉取真实搜索结果。"
        )
        raw = save_record(self.db, "seoProviderResults", {
            "taskId": payload.get("taskId") or "",
            "taskType": task_type,
            "recordKind": kind,
            "sourceRecordId": record["id"] if record else "",
            "providerConfigId": provider_config_id,
            "provider": provider_result.get("provider") or payload.get("provider") or "configured-provider",
            "status": status,
            "requestPayload": payload,
            "response": provider_result,
            "createdAt": collected_at,
            "updatedAt": collected_at,
        })
        created_records = self.persist_seo_provider_result(task_type, payload, provider_result, record or {}, status, collected_at, raw["id"])
        updated = None
        if record and status == "provider_pending":
            # Only patch the original queued shell when provider is unavailable.
            # On success, persist_* already wrote topResults/questions onto the same id —
            # re-saving **record would wipe those fields back to empty.
            patch_fields: dict[str, Any] = {
                **record,
                "status": status,
                "lastCollectedAt": collected_at,
                "providerPayload": payload,
                "providerResult": provider_result,
                "providerResultId": raw["id"],
                "errorMessage": pending_message,
                "updatedAt": collected_at,
            }
            if kind == "serpAnalyses":
                patch_fields["topResults"] = []
                patch_fields["relatedQuestions"] = []
                patch_fields["relatedKeywords"] = []
                patch_fields["contentBrief"] = (
                    f"未连上真实搜索数据源：{pending_message}"
                    " 请确认环境变量 DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD，或关掉 SERP 直接写。"
                )
            updated = save_record(self.db, kind, patch_fields)
        elif record and status == "collected":
            updated = patch_record(self.db, kind, record["id"], {
                "status": "collected",
                "lastCollectedAt": collected_at,
                "providerPayload": payload,
                "providerResult": provider_result,
                "providerResultId": raw["id"],
                "errorMessage": "",
                "updatedAt": collected_at,
            })
        elif created_records:
            updated = created_records[0]
        log_task_event(self.db, str(payload.get("taskId") or ""), "seo.collected", f"SEO provider returned {len(created_records)} normalized records", detail={"taskType": task_type, "recordIds": [item.get("id") for item in created_records]}) if payload.get("taskId") else None
        primary_record = updated or (created_records[0] if created_records else raw)
        return {"recordKind": kind, "recordId": primary_record["id"], "status": status, "providerResultId": raw["id"], "normalizedCount": len(created_records)}

    def persist_seo_provider_result(
        self,
        task_type: str,
        payload: dict[str, Any],
        provider_result: dict[str, Any],
        source_record: dict[str, Any],
        status: str,
        collected_at: str,
        raw_result_id: str,
    ) -> list[dict]:
        if status == "provider_pending":
            return []
        provider_name = provider_result.get("provider") or payload.get("provider") or "configured-provider"
        if task_type == "keyword-discover":
            return self.persist_keywords(payload, provider_result, provider_name, collected_at, raw_result_id)
        if task_type == "serp-collect":
            return [self.persist_serp_analysis(payload, provider_result, provider_name, collected_at, raw_result_id)]
        if task_type == "geo-collect":
            return self.persist_geo_questions(payload, provider_result, provider_name, collected_at, raw_result_id)
        if task_type == "ranking-check":
            return self.persist_rankings(payload, provider_result, provider_name, collected_at, raw_result_id)
        return [source_record]

    def persist_keywords(self, payload: dict[str, Any], provider_result: dict[str, Any], provider_name: str, collected_at: str, raw_result_id: str) -> list[dict]:
        items = first_list(provider_result, ["keywords", "items", "data", "results"])
        saved = []
        for index, item in enumerate(items):
            if not isinstance(item, dict):
                continue
            word = str(item.get("word") or item.get("keyword") or item.get("query") or "").strip()
            if not word:
                continue
            saved.append(save_record(self.db, "keywords", {
                "word": word,
                "seed": payload.get("seed") or payload.get("keyword") or "",
                "searchVolume": int(item.get("searchVolume") or item.get("volume") or 0),
                "difficulty": int(item.get("difficulty") or item.get("competition") or 0),
                "trend": item.get("trend") or "stable",
                "relatedWords": list_value(item.get("relatedWords") or item.get("related") or []),
                "status": item.get("status") or "suggested",
                "provider": provider_name,
                "providerResultId": raw_result_id,
                "providerPayload": item,
                "lastCollectedAt": collected_at,
                "createdAt": collected_at,
                "updatedAt": collected_at,
            }))
        return saved

    def persist_serp_analysis(self, payload: dict[str, Any], provider_result: dict[str, Any], provider_name: str, collected_at: str, raw_result_id: str) -> dict:
        results = first_list(provider_result, ["topResults", "results", "items", "organicResults"])
        normalized_results = []
        for index, item in enumerate(results):
            if not isinstance(item, dict):
                continue
            normalized_results.append({
                "position": int(item.get("position") or item.get("rank") or index + 1),
                "title": item.get("title") or "",
                "url": item.get("url") or item.get("link") or "",
                "domain": item.get("domain") or "",
                "snippet": item.get("snippet") or item.get("description") or "",
            })
        keyword = str(provider_result.get("keyword") or payload.get("keyword") or payload.get("seed") or "")
        related_questions = list_value(provider_result.get("relatedQuestions") or provider_result.get("questions") or [])
        related_keywords = list_value(provider_result.get("relatedKeywords") or provider_result.get("keywords") or [])
        brief = str(provider_result.get("contentBrief") or provider_result.get("brief") or "").strip()
        if not brief and normalized_results:
            title_lines = [f"{item['position']}. {item['title']}（{item['domain']}）" for item in normalized_results[:8] if item.get("title")]
            question_lines = related_questions[:5]
            brief = (
                f"关键词「{keyword}」真实 SERP 竞品标题：\n"
                + "\n".join(title_lines)
                + ("\n相关问题：\n" + "\n".join(f"- {q}" for q in question_lines) if question_lines else "")
                + "\n请基于以上竞品差距写一篇可执行的指南文章。"
            )
        elif not brief:
            brief = f"关键词「{keyword}」暂无可用竞品结果，请检查搜索数据源配置。"
        record_id = str(payload.get("recordId") or "")
        existing = get_record(self.db, "serpAnalyses", record_id) if record_id and find_record(self.db, "serpAnalyses", record_id) else None
        return save_record(self.db, "serpAnalyses", {
            **(existing or {}),
            "id": record_id or (existing or {}).get("id") or make_id("serpAnalyses"),
            "keyword": keyword,
            "searchEngine": provider_result.get("searchEngine") or payload.get("searchEngine") or payload.get("engine") or "Google",
            "region": provider_result.get("region") or payload.get("region") or "global",
            "device": provider_result.get("device") or payload.get("device") or "desktop",
            "topResults": normalized_results,
            "relatedQuestions": related_questions,
            "relatedKeywords": related_keywords,
            "contentBrief": brief,
            "provider": provider_name,
            "providerResultId": raw_result_id,
            "status": "collected",
            "errorMessage": "",
            "analyzedAt": collected_at,
            "createdAt": (existing or {}).get("createdAt") or collected_at,
            "updatedAt": collected_at,
        })

    def persist_geo_questions(self, payload: dict[str, Any], provider_result: dict[str, Any], provider_name: str, collected_at: str, raw_result_id: str) -> list[dict]:
        items = first_list(provider_result, ["questions", "items", "data", "results"])
        saved = []
        for item in items:
            if not isinstance(item, dict):
                continue
            question = str(item.get("question") or item.get("query") or "").strip()
            if not question:
                continue
            saved.append(save_record(self.db, "geoQuestions", {
                "keyword": item.get("keyword") or payload.get("keyword") or payload.get("brand") or "",
                "question": question,
                "platform": item.get("platform") or payload.get("platform") or provider_name,
                "sourceUrl": item.get("sourceUrl") or item.get("url") or "",
                "sourceMedia": item.get("sourceMedia") or item.get("domain") or "",
                "answerExcerpt": item.get("answerExcerpt") or item.get("answer") or item.get("snippet") or "",
                "brandMention": bool(item.get("brandMention") if "brandMention" in item else item.get("brandMentioned", False)),
                "competitorMention": bool(item.get("competitorMention") if "competitorMention" in item else item.get("competitorMentioned", False)),
                "provider": provider_name,
                "providerResultId": raw_result_id,
                "status": "collected",
                "queryTime": collected_at,
                "createdAt": collected_at,
                "updatedAt": collected_at,
            }))
        return saved

    def persist_rankings(self, payload: dict[str, Any], provider_result: dict[str, Any], provider_name: str, collected_at: str, raw_result_id: str) -> list[dict]:
        items = first_list(provider_result, ["rankings", "items", "data", "results"])
        if not items and any(key in provider_result for key in ["rank", "position"]):
            items = [provider_result]
        saved = []
        for item in items:
            if not isinstance(item, dict):
                continue
            position = int(item.get("position") or item.get("rank") or 0)
            previous = item.get("previousPosition")
            previous_position = int(previous) if previous not in (None, "") else None
            saved.append(save_record(self.db, "rankingEntries", {
                "keyword": item.get("keyword") or payload.get("keyword") or "",
                "url": item.get("url") or payload.get("url") or "",
                "engine": item.get("engine") or payload.get("engine") or payload.get("searchEngine") or "Google",
                "region": item.get("region") or payload.get("region") or "global",
                "position": position,
                "previousPosition": previous_position,
                "change": (previous_position - position) if previous_position is not None and position else 0,
                "status": item.get("status") or ("indexed" if position else "not_found"),
                "provider": provider_name,
                "providerResultId": raw_result_id,
                "checkedAt": collected_at,
                "createdAt": collected_at,
                "updatedAt": collected_at,
            }))
        return saved


ASSET_CLEANUP_MIN_INTERVAL_SECONDS = 6 * 3600
ASSET_CLEANUP_ASSETS_KEEP = 50
ASSET_CLEANUP_ASSETS_MAX_AGE_DAYS = 7
ASSET_CLEANUP_PROFILES_MAX_AGE_DAYS = 14


def asset_cleanup_command_is_due(
    commands: list[dict],
    device_id: str,
    now: datetime | None = None,
    min_interval_seconds: float = ASSET_CLEANUP_MIN_INTERVAL_SECONDS,
) -> bool:
    """Decide whether this device is ready for another asset cleanup sweep.

    An in-flight command on the same device always blocks a new one, and a
    terminal command holds the next one off until the cooldown has passed, so
    a chatty scheduler cannot turn into a delete loop.
    """
    latest_terminal: datetime | None = None
    for command in commands:
        if str(command.get("type") or "") != "cleanup_assets":
            continue
        if device_id and str(command.get("deviceId") or "") not in {"", device_id}:
            continue
        status = str(command.get("status") or "")
        if status in {"queued", "running"}:
            if not device_id or str(command.get("deviceId") or "") == device_id:
                return False
            continue
        stamp = parse_desktop_command_timestamp(command.get("updatedAt") or command.get("createdAt"), now=now)
        if stamp and (latest_terminal is None or stamp > latest_terminal):
            latest_terminal = stamp
    if latest_terminal is None:
        return True
    current = now or datetime.now(latest_terminal.tzinfo)
    # Compare in the stamp's own zone, the same way the stale-discovery check does.
    if current.tzinfo is None:
        current = current.replace(tzinfo=latest_terminal.tzinfo)
    else:
        current = current.astimezone(latest_terminal.tzinfo)
    return (current - latest_terminal).total_seconds() >= max(float(min_interval_seconds), 0.0)


class Scheduler:
    def __init__(self, db: Session, queue: QueueClient | Any = queue_client) -> None:
        self.db = db
        self.queue = queue

    def _scheduler_owner_ids(self) -> list[str]:
        owner_ids = self.db.scalars(select(Record.owner_id).distinct()).all()
        return sorted({str(owner_id).strip() for owner_id in owner_ids if str(owner_id).strip()})

    def enqueue_due_jobs(self) -> dict[str, int]:
        # Asset cleanup is global on purpose: its keep set spans every owner,
        # so it runs outside the per-owner actor scope below.
        cleanup_count = self.enqueue_desktop_asset_cleanup()
        if current_owner_id():
            result = self._enqueue_due_jobs_for_owner()
            result["desktopAssetCleanup"] = cleanup_count
            return result
        totals = {
            "knowledgeRefresh": 0,
            "indexRetry": 0,
            "mediaPublicationRecheck": 0,
            "mediaPublicationDiscovery": 0,
            "mediaSessionValidation": 0,
            "desktopAssetCleanup": cleanup_count,
        }
        for owner_id in self._scheduler_owner_ids():
            with actor_scope(ActorContext.system_worker(owner_id)):
                result = self._enqueue_due_jobs_for_owner()
            for key, value in result.items():
                totals[key] = totals.get(key, 0) + int(value or 0)
        return totals

    def enqueue_desktop_asset_cleanup(self) -> int:
        keep_profile_keys = desktop_asset_cleanup_keep_profile_keys(self.db)
        commands = list_records(self.db, "desktopCommands")
        current = app_time.now()
        count = 0
        for device in list_records(self.db, "desktopDevices"):
            device_id = str(device.get("id") or "")
            if not device_id or not desktop_device_is_live(device, now=current):
                # An offline device would never claim the command, and a
                # stranded command blocks every later sweep for it.
                continue
            if not desktop_supports_asset_cleanup(device):
                continue
            if not asset_cleanup_command_is_due(commands, device_id, now=current):
                continue
            owner_id = str(device.get("boundOwnerId") or "") or "legacy-internal-owner"
            with actor_scope(ActorContext.system_worker(owner_id)):
                command = save_record(self.db, "desktopCommands", {
                    "id": make_id("desktopCommands"),
                    "deviceId": device_id,
                    "type": "cleanup_assets",
                    "payload": {
                        "assetsKeep": ASSET_CLEANUP_ASSETS_KEEP,
                        "assetsMaxAgeDays": ASSET_CLEANUP_ASSETS_MAX_AGE_DAYS,
                        "profilesMaxAgeDays": ASSET_CLEANUP_PROFILES_MAX_AGE_DAYS,
                        "keepProfileKeys": sorted(keep_profile_keys),
                        "source": "scheduler",
                    },
                    "status": "queued",
                    "result": {},
                    "errorMessage": "",
                    "createdAt": app_time.now_stamp(),
                    "updatedAt": app_time.now_stamp(),
                })
                audit_event(self.db, "desktop_command.create", "desktopCommands", command["id"], {
                    "type": "cleanup_assets",
                    "deviceId": device_id,
                    "source": "scheduler",
                })
            count += 1
        return count

    def _enqueue_due_jobs_for_owner(self) -> dict[str, int]:
        knowledge_count = 0
        index_retry_count = 0
        active_tasks = [
            task for task in list_records(self.db, "tasks")
            if task.get("status") in {"queued", "pending", "running"}
        ]
        active_knowledge_ids = {
            str(task.get("payload", {}).get("knowledgeId") or "")
            for task in active_tasks
            if task.get("type") == "knowledge-fetch-url"
        }
        active_submission_ids = {
            str(task.get("payload", {}).get("submissionId") or "")
            for task in active_tasks
            if task.get("type") == "inclusion-check"
        }
        for item in list_records(self.db, "knowledgeItems"):
            if (
                item.get("source") == "web"
                and item.get("refreshMode") == "scheduled"
                and item.get("url")
                and item["id"] not in active_knowledge_ids
            ):
                create_task(self.db, "knowledge-fetch-url", f"Scheduled knowledge refresh: {item.get('title')}", {"knowledgeId": item["id"], "url": item["url"]}, "knowledge", queue_backend=self.queue)
                active_knowledge_ids.add(item["id"])
                knowledge_count += 1
        for submission in list_records(self.db, "indexSubmissions"):
            if (
                submission.get("inclusionStatus") in {"not_indexed", "failed", "unchecked"}
                and submission.get("status") not in {"pending", "submitting"}
                and inclusion_verification_is_due(submission)
                and submission.get("url")
                and submission["id"] not in active_submission_ids
            ):
                create_task(self.db, "inclusion-check", f"Retry inclusion check: {submission.get('articleTitle')}", {"submissionId": submission["id"]}, "index", queue_backend=self.queue)
                active_submission_ids.add(submission["id"])
                index_retry_count += 1
        media_counts = self.enqueue_media_publication_jobs()
        validation_count = self.enqueue_media_session_validations()
        from .video_publishing import cleanup_unused_video_assets
        video_cleanup_count = cleanup_unused_video_assets(self.db)
        return {
            "knowledgeRefresh": knowledge_count,
            "indexRetry": index_retry_count,
            **media_counts,
            "mediaSessionValidation": validation_count,
            "videoAssetCleanup": video_cleanup_count,
        }

    def enqueue_media_session_validations(self) -> int:
        count = 0
        active_account_ids = {
            str(command.get("mediaAccountId") or "")
            for command in list_records(self.db, "desktopCommands")
            if command.get("type") in {"validate_session", "publish_article", "publish_video", "discover_publication"}
            and command.get("status") in {"queued", "running"}
            and desktop_command_target_device_is_live(self.db, command)
        }
        active_bindings = {}
        for binding in list_records(self.db, "mediaAccountBindings"):
            if binding.get("status") == "active" and binding.get("mediaAccountId") and binding.get("deviceId"):
                active_bindings[str(binding["mediaAccountId"])] = binding
        for account in list_canonical_media_accounts(self.db):
            account_id = str(account.get("id") or "")
            if (
                account.get("status") != "active"
                or account.get("credentialStatus") not in {"active", "stale"}
                or not account.get("authArtifactId")
                or account_id in active_account_ids
                or account_id not in active_bindings
            ):
                continue
            if not account.get("nextCredentialCheckAt") and account.get("credentialStatus") == "active":
                patch_record(self.db, "mediaAccounts", account_id, {
                    "nextCredentialCheckAt": next_credential_check_at(
                        str(account.get("platform") or ""),
                        str(account.get("credentialExpiresAt") or ""),
                    ),
                })
                continue
            if not credential_validation_is_due(account):
                continue
            binding = active_bindings[account_id]
            channel_device_id = resolve_media_account_channel_device(self.db, str(binding.get("deviceId") or ""))
            if not desktop_device_is_live(find_record(self.db, "desktopDevices", channel_device_id)):
                # No live desktop agent for this owner: wait instead of stranding the
                # command on a device that can never claim it.
                continue
            binding = point_media_account_binding_at_device(self.db, account_id, channel_device_id) or binding
            command = save_record(self.db, "desktopCommands", {
                "id": make_id("desktopCommands"),
                "deviceId": channel_device_id,
                "type": "validate_session",
                "mediaAccountId": account_id,
                "payload": {
                    "platform": account.get("platform") or "",
                    "profileKey": account.get("profileKey") or account_id,
                    "source": "scheduler",
                },
                "status": "queued",
                "result": {},
                "errorMessage": "",
                "createdAt": app_time.now_stamp(),
                "updatedAt": app_time.now_stamp(),
            })
            audit_event(self.db, "desktop_command.create", "desktopCommands", command["id"], {
                "type": "validate_session",
                "deviceId": command.get("deviceId"),
                "source": "scheduler",
            })
            active_account_ids.add(account_id)
            count += 1
        return count

    def enqueue_media_publication_jobs(self) -> dict[str, int]:
        if current_owner_id():
            return self._enqueue_media_publication_jobs_for_owner()
        totals = {"mediaPublicationRecheck": 0, "mediaPublicationDiscovery": 0, "videoPublicationDiscovery": 0}
        for owner_id in self._scheduler_owner_ids():
            with actor_scope(ActorContext.system_worker(owner_id)):
                result = self._enqueue_media_publication_jobs_for_owner()
            for key, value in result.items():
                totals[key] = totals.get(key, 0) + int(value or 0)
        return totals

    def cleanup_video_assets(self) -> int:
        """Run private orphan cleanup on the six-hour maintenance cadence."""
        from .video_publishing import cleanup_unused_video_assets
        if current_owner_id():
            return cleanup_unused_video_assets(self.db)
        total = 0
        for owner_id in self._scheduler_owner_ids():
            with actor_scope(ActorContext.system_worker(owner_id)):
                total += cleanup_unused_video_assets(self.db)
        return total

    def _enqueue_media_publication_jobs_for_owner(self) -> dict[str, int]:
        review_count = 0
        discovery_count = 0
        existing_review_tasks = {
            str(task.get("payload", {}).get("orderId") or "")
            for task in list_records(self.db, "tasks")
            if task.get("type") == "media-publication-recheck" and task.get("status") in {"queued", "pending", "running"}
        }
        for order in list_records(self.db, "mediaOrders"):
            if order.get("status") == "review_required" and order.get("reviewStatus") in {"pending_public_visibility", "public_pending", "reviewing"}:
                article_id = str(order.get("articleId") or "").strip()
                article = find_record(self.db, "articles", article_id) if article_id else None
                if article_id and not article:
                    patch_record(self.db, "mediaOrders", order["id"], {
                        "publicDiscoveryStatus": "failed",
                        "backlinkStatus": "blocked",
                        "errorMessage": "Publication discovery skipped: source article no longer exists.",
                    })
                    continue
                candidate = order.get("reviewUrl") or order.get("backlinkUrl")
                account_id = media_order_account_id(order)
                account = find_record(self.db, "mediaAccounts", account_id) if account_id else None
                platform = str(order.get("platform") or account and account.get("platform") or "")
                discovery_status = str(order.get("publicDiscoveryStatus") or "")
                needs_discovery = publication_discovery_required(platform, str(candidate or ""), discovery_status)
                if needs_discovery:
                    if not publication_discovery_is_due(order):
                        continue
                    try:
                        queued = queue_media_publication_discovery(self.db, {
                            "orderId": order["id"],
                            "provider": "IndexNow",
                            "checkImmediately": True,
                        })
                        if not queued.get("deduplicated"):
                            discovery_count += 1
                    except Exception as exc:
                        patch_record(self.db, "mediaOrders", order["id"], {
                            "publicDiscoveryStatus": "failed",
                            "errorMessage": f"Public URL discovery task is pending: {exc}",
                        })
                    continue
                if candidate and order["id"] not in existing_review_tasks:
                    if media_publication_recheck_is_exhausted(order):
                        # Write the give-up once. The order stays review_required on
                        # purpose: whether to fail it for good is an operator call,
                        # not something the scheduler should decide silently.
                        if str(order.get("publicCheckStatus") or "") != "exhausted":
                            patch_record(self.db, "mediaOrders", order["id"], {
                                "publicCheckStatus": "exhausted",
                                "backlinkStatus": "blocked",
                                "errorMessage": (
                                    "公开页复验已达上限，已停止自动复验；"
                                    "请人工确认该链接是否可公开访问。"
                                ),
                            })
                        continue
                    # A public URL on file does not mean the order is verifiable: only a
                    # discover command re-reads the public page in the desktop browser, so
                    # an order whose public image stage is still short of evidence would
                    # loop on PUBLIC_IMAGE_EVIDENCE_INCOMPLETE forever on the server-side
                    # recheck alone. Route those through discovery, the same way the manual
                    # recheck endpoint does. An unverifiable public stage counts as verified
                    # here, so a platform-blocked page keeps the cheap recheck instead.
                    if (
                        platform in PUBLICATION_DISCOVERY_PLATFORMS
                        and media_order_requires_image_publication_evidence(order, article)
                        and not media_order_image_publication_evidence_is_verified(order, article)
                    ):
                        if not publication_discovery_is_due(order):
                            continue
                        try:
                            queued = queue_media_publication_discovery(self.db, {
                                "orderId": order["id"],
                                "provider": "IndexNow",
                                "checkImmediately": True,
                            })
                            if not queued.get("deduplicated"):
                                discovery_count += 1
                        except Exception as exc:
                            patch_record(self.db, "mediaOrders", order["id"], {
                                "errorMessage": f"Public page image recheck is pending: {exc}",
                            })
                        continue
                    if not media_publication_recheck_is_due(order):
                        continue
                    create_task(self.db, "media-publication-recheck", f"Recheck media publication: {order.get('articleTitle')}", {
                        "orderId": order["id"],
                        "provider": "IndexNow",
                        "checkImmediately": True,
                    }, "media", queue_backend=self.queue)
                    review_count += 1
        # This path is called by worker_cli's periodic media tick as well as
        # startup. Keeping video discovery here covers videos created after
        # the worker started, inside the same per-owner authority scope.
        from .video_publishing import enqueue_video_discoveries
        video_discovery_count = enqueue_video_discoveries(self.db)
        return {
            "mediaPublicationRecheck": review_count,
            "mediaPublicationDiscovery": discovery_count,
            "videoPublicationDiscovery": video_discovery_count,
        }
