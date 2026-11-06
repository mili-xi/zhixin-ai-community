import os
import json
from pathlib import Path

import pytest

os.environ["DATABASE_URL"] = f"sqlite:///{Path(__file__).parent / 'test.sqlite'}"
os.environ["DEEPSEEK_OFFLINE_MODE"] = "true"
os.environ["AUTH_REGISTRATION_ENABLED"] = "true"
os.environ["AUTH_DEBUG_RETURN_CODE"] = "true"

from fastapi.testclient import TestClient

from app.database import Base, Record, SessionLocal, engine
from app import main as main_module
from app.main import app
from app.service import candidate_publication_url_is_publishable, current_auto_publish_commands, get_record, list_records, patch_record, publication_discovery_required, save_record, supersede_duplicate_media_accounts
from app.service import recover_public_only_image_publication_evidence
from app.auth.context import actor_scope


client = TestClient(app)


def setup_function():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)


def complete_media_authorization(device: dict, *, platform: str, account_name: str, fingerprint: str) -> dict:
    created = client.post("/api/media-auth-sessions", json={
        "platform": platform,
        "deviceId": device["device"]["id"],
    }).json()
    session = created["session"]
    claimed = client.post(
        f"/api/desktop-devices/{device['device']['id']}/media-auth-sessions/{session['id']}/claim",
        json={"pairingCode": session["pairingCode"], "deviceToken": device["deviceToken"]},
    )
    assert claimed.status_code == 200
    submitted = client.post(f"/api/media-auth-sessions/{session['id']}/artifacts", json={
        "deviceId": device["device"]["id"],
        "accountName": account_name,
        "artifact": {
            "cookies": f"encrypted-cookie-{fingerprint}",
            "localStorage": f"encrypted-local-storage-{fingerprint}",
            "sessionStorage": f"encrypted-session-storage-{fingerprint}",
            "fingerprint": fingerprint,
            "authorizationEvidence": {
                "strongCookiePresent": True,
                "workspaceReady": True,
                "currentUrl": "https://www.zhihu.com/creator",
                "pageTitle": "Zhihu creator center",
            },
        },
    })
    assert submitted.status_code == 200
    bound = client.post(
        f"/api/media-auth-sessions/{session['id']}/bind",
        json={"name": account_name},
    )
    assert bound.status_code == 200
    return {
        "session": session,
        "artifact": submitted.json()["artifact"],
        **bound.json(),
    }


def test_health_and_empty_lists_do_not_seed_mock_data():
    assert client.get("/health").json()["status"] == "ok"
    assert client.get("/api/queues/health").json()["configured"] is True
    assert client.get("/api/articles").json() == []
    assert client.get("/api/sites").json() == []
    assert client.get("/api/brand-library").json() == []
    assert client.get("/api/dashboard/metrics").json()["totalArticles"] == 0


def test_media_auth_artifact_persists_sanitized_platform_config_snapshot():
    device = client.post("/api/desktop-devices/register", json={
        "deviceName": "Config snapshot device",
        "platform": "windows",
        "appVersion": "0.1.0",
        "publicKey": "config-snapshot-device-key",
    }).json()
    created = client.post("/api/media-auth-sessions", json={
        "platform": "sohu",
        "deviceId": device["device"]["id"],
    }).json()
    session = created["session"]
    claim = client.post(
        f"/api/desktop-devices/{device['device']['id']}/media-auth-sessions/{session['id']}/claim",
        json={"pairingCode": session["pairingCode"], "deviceToken": device["deviceToken"]},
    )
    assert claim.status_code == 200

    submitted = client.post(f"/api/media-auth-sessions/{session['id']}/artifacts", json={
        "deviceId": device["device"]["id"],
        "accountName": "Sohu Config Account",
        "artifact": {
            "cookies": "encrypted-cookie-config-snapshot",
            "localStorage": "encrypted-local-config-snapshot",
            "sessionStorage": "encrypted-session-config-snapshot",
            "fingerprint": "config-snapshot-fingerprint",
            "authorizationEvidence": {
                "strongCookiePresent": True,
                "workspaceReady": True,
                "currentUrl": "https://mp.sohu.com/pc/compose",
                "pageTitle": "搜狐号内容管理",
            },
            "platformConfig": {
                "schemaVersion": 1,
                "fetchedAt": "2026-07-27T10:00:00.000Z",
                "accountId": "122929277",
                "channelId": 47,
                "categoryId": -1,
                "declaration": "not_original",
                "cookies": "raw-cookie-must-not-leak",
                "sourceEvidence": {
                    "endpoint": "https://mp.sohu.com/account/task/getAccountTaskList",
                    "httpStatus": 200,
                    "businessStatus": "success",
                    "rawCookie": "raw-cookie-must-not-leak",
                },
            },
            "capabilities": {
                "schemaVersion": 1,
                "fetchedAt": "2026-07-27T10:00:00.000Z",
                "canPublishArticle": True,
                "canUploadImages": True,
                "requiresCover": True,
                "requiredFields": ["title", "content", "cover"],
                "encryptedCookies": "encrypted-cookie-must-not-leak",
            },
        },
    })
    assert submitted.status_code == 200

    bound = client.post(
        f"/api/media-auth-sessions/{session['id']}/bind",
        json={"name": "Sohu Config Account"},
    )
    assert bound.status_code == 200
    account = bound.json()["mediaAccount"]
    assert account["platformConfig"]["accountId"] == "122929277"
    assert account["platformConfig"]["channelId"] == 47
    assert account["platformConfig"]["sourceEvidence"]["endpoint"].endswith("getAccountTaskList")
    assert account["capabilities"]["canPublishArticle"] is True
    assert account["capabilities"]["requiredFields"] == ["title", "content", "cover"]

    serialized = str(account)
    assert "raw-cookie-must-not-leak" not in serialized
    assert "encrypted-cookie-must-not-leak" not in serialized


def test_crud_resources_are_persisted():
    created = client.post("/api/sites", json={"name": "主站", "type": "WordPress", "baseUrl": "https://example.com"}).json()
    assert created["id"].startswith("site-")
    assert created["status"] == "active"

    updated = client.patch(f"/api/sites/{created['id']}", json={"status": "disabled"}).json()
    assert updated["status"] == "disabled"
    assert client.get("/api/sites").json()[0]["status"] == "disabled"

    brand = client.post("/api/brand-library", json={"name": "智心AI", "tags": ["AI SEO"]}).json()
    assert brand["name"] == "智心AI"
    assert client.delete(f"/api/brand-library/{brand['id']}").json()["deleted"] is True
    assert client.get("/api/brand-library").json() == []


def test_generate_article_and_management_view():
    result = client.post("/api/articles/generate", json={"keyword": "AI SEO", "mode": "normal"}).json()
    assert result["queued"] is True
    assert result["task"]["type"] == "ai-generate-article"
    assert result["task"]["queue"] == "ai"

    center = client.get("/api/articles?view=management").json()
    assert center["summary"]["total"] == 0
    assert center["records"] == []


def test_ai_provider_status_is_redacted_and_reports_article_models():
    result = client.get("/api/ai/providers/status").json()

    assert result["text"]["provider"] == "deepseek"
    assert result["text"]["model"] == "deepseek-v4-pro"
    assert result["image"]["provider"] == "stepfun"
    assert result["image"]["model"] == "step-image-edit-2"
    assert "apiKey" not in result["text"]
    assert "apiKey" not in result["image"]


def test_generate_article_defaults_to_dynamic_inline_images_and_rejects_excess_images():
    queued = client.post("/api/articles/generate", json={"keyword": "AI 图文文章"})

    assert queued.status_code == 200
    payload = queued.json()["task"]["payload"]
    assert payload["generateImages"] is True
    assert payload["imageStrategy"] == "cover-and-inline"
    assert payload["maxInlineImages"] == 5

    accepted = client.post("/api/articles/generate", json={
        "keyword": "章节感知配图",
        "generateImages": True,
        "maxInlineImages": 5,
    })
    assert accepted.status_code == 200

    invalid = client.post("/api/articles/generate", json={
        "keyword": "过多配图",
        "generateImages": True,
        "maxInlineImages": 6,
    })
    assert invalid.status_code == 400
    assert invalid.json()["detail"] == "MAX_INLINE_IMAGES_OUT_OF_RANGE"


def test_delete_article_removes_local_content_and_preserves_publication_history():
    article = client.post("/api/articles", json={
        "title": "待删除的本地文章",
        "keyword": "文章删除",
        "status": "ready",
    }).json()
    media_order = client.post("/api/media-orders", json={
        "articleId": article["id"],
        "articleTitle": article["title"],
        "resourceName": "知乎",
        "status": "succeeded",
        "backlinkStatus": "generated",
        "backlinkUrl": "https://www.zhihu.com/p/123456",
    }).json()
    submission = client.post("/api/index-submissions", json={
        "articleId": article["id"],
        "articleTitle": article["title"],
        "url": media_order["backlinkUrl"],
        "provider": "IndexNow",
    }).json()

    response = client.delete(f"/api/articles/{article['id']}")

    assert response.status_code == 200
    result = response.json()
    assert result["deleted"] is True
    assert result["articleId"] == article["id"]
    assert result["retainedHistory"] == {
        "publishJobs": 0,
        "mediaOrders": 1,
        "indexSubmissions": 1,
        "completedWorkflows": 0,
    }
    assert client.get(f"/api/articles/{article['id']}").status_code == 404
    assert client.get("/api/articles?view=management").json()["summary"]["total"] == 0
    assert client.get("/api/media-orders").json()[0]["id"] == media_order["id"]
    assert client.get("/api/index-submissions").json()[0]["id"] == submission["id"]

    with SessionLocal() as db:
        audit = next(
            item for item in list_records(db, "auditLogs")
            if item.get("targetId") == article["id"] and item.get("action") == "article.delete"
        )
    assert audit["action"] == "article.delete"
    assert audit["detail"]["retainedHistory"]["mediaOrders"] == 1


def test_batch_delete_articles_is_atomic_when_an_article_has_an_active_workflow():
    deletable = client.post("/api/articles", json={"title": "可删除文章", "status": "draft"}).json()
    protected = client.post("/api/articles", json={"title": "发布中的文章", "status": "ready"}).json()
    task = client.post("/api/tasks", json={
        "type": "publish-and-index",
        "title": "正在发布文章",
        "queue": "publish",
        "status": "queued",
        "payload": {"articleId": protected["id"]},
    }).json()

    blocked = client.post("/api/articles/batch-delete", json={
        "articleIds": [deletable["id"], protected["id"]],
    })

    assert blocked.status_code == 409
    detail = blocked.json()["detail"]
    assert detail["code"] == "ARTICLE_DELETE_ACTIVE_WORKFLOW"
    assert detail["articleId"] == protected["id"]
    assert detail["activeWorkflows"] == [{
        "id": task["id"],
        "kind": "tasks",
        "status": "queued",
        "type": "publish-and-index",
    }]
    assert client.get(f"/api/articles/{deletable['id']}").status_code == 200
    assert client.get(f"/api/articles/{protected['id']}").status_code == 200

    with SessionLocal() as db:
        patch_record(db, "tasks", task["id"], {"status": "failed"})
    deleted = client.post("/api/articles/batch-delete", json={
        "articleIds": [deletable["id"], protected["id"]],
    })

    assert deleted.status_code == 200
    assert deleted.json()["deleted"] == 2
    assert client.get("/api/articles").json() == []


def test_publication_discovery_does_not_block_article_deletion_but_publish_command_does():
    discoverable = client.post("/api/articles", json={"title": "等待公开地址的文章", "status": "published"}).json()
    publishing = client.post("/api/articles", json={"title": "正在发布的文章", "status": "ready"}).json()
    with SessionLocal() as db:
        discovery_command = save_record(db, "desktopCommands", {
            "type": "discover_publication",
            "status": "running",
            "payload": {"articleId": discoverable["id"]},
        })
        publish_command = save_record(db, "desktopCommands", {
            "type": "publish_article",
            "status": "running",
            "payload": {"articleId": publishing["id"]},
        })

    deleted = client.delete(f"/api/articles/{discoverable['id']}")

    assert deleted.status_code == 200
    assert client.get(f"/api/articles/{discoverable['id']}").status_code == 404
    with SessionLocal() as db:
        assert get_record(db, "desktopCommands", discovery_command["id"])["status"] == "running"

    blocked = client.delete(f"/api/articles/{publishing['id']}")

    assert blocked.status_code == 409
    detail = blocked.json()["detail"]
    assert detail["articleTitle"] == publishing["title"]
    assert detail["activeWorkflows"] == [{
        "id": publish_command["id"],
        "kind": "desktopCommands",
        "status": "running",
        "type": "publish_article",
    }]


def test_publish_and_index_defaults_to_queue_without_immediate_publish():
    article = client.post("/api/articles", json={"title": "发布闭环", "keyword": "SEO", "status": "ready"}).json()
    site = client.post("/api/sites", json={"name": "官网", "type": "Webhook", "baseUrl": "https://site.test"}).json()

    result = client.post("/api/publish-and-index", json={
        "articleId": article["id"],
        "siteId": site["id"],
        "provider": "IndexNow",
        "checkImmediately": True
    }).json()

    assert result["queued"] is True
    assert result["task"]["type"] == "publish-and-index"
    assert result["task"]["queue"] == "publish"
    assert result["task"]["payload"]["articleId"] == article["id"]
    assert result["task"]["payload"]["siteId"] == site["id"]
    assert result["task"]["payload"]["checkImmediately"] is True
    assert client.get("/api/publish-jobs").json() == []
    assert client.get("/api/index-submissions").json() == []


def test_direct_publish_job_without_real_url_does_not_create_fake_publication():
    article = client.post("/api/articles", json={"title": "Real URL Required", "keyword": "SEO", "status": "ready"}).json()
    site = client.post("/api/sites", json={"name": "Unconfigured Site", "type": "Webhook", "baseUrl": "https://site.test"}).json()

    job = client.post("/api/publish-jobs", json={"articleId": article["id"], "siteId": site["id"]}).json()

    assert job["articleId"] == article["id"]
    assert job["status"] == "pending"
    assert job["publishedUrl"] == ""
    assert "site.test/articles" not in str(job)
    assert client.get("/api/published-center").json()["records"] == []
    updated_article = client.get(f"/api/articles/{article['id']}").json()
    assert updated_article["status"] == "ready"
    assert updated_article.get("publishedUrl", "") == ""


def test_orphan_legacy_publication_records_do_not_pollute_article_workflow_views():
    article = client.post("/api/articles", json={"title": "Workflow Source Article", "keyword": "SEO", "status": "ready"}).json()
    with SessionLocal() as db:
        save_record(db, "publishJobs", {
            "id": "legacy-publish-job",
            "articleTitle": article["title"],
            "siteName": "Legacy Demo Site",
            "connectorType": "Webhook",
            "status": "succeeded",
            "publishedUrl": "https://legacy.example/articles/demo",
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z",
        })
        save_record(db, "mediaOrders", {
            "id": "legacy-media-order",
            "articleTitle": article["title"],
            "resourceName": "Legacy Media",
            "resourceId": "resource-custom",
            "status": "succeeded",
            "backlinkStatus": "published",
            "backlinkUrl": "https://legacy.example/backlink/demo",
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z",
        })
        save_record(db, "indexSubmissions", {
            "id": "legacy-index-submission",
            "articleTitle": article["title"],
            "provider": "Google",
            "source": "manual",
            "sourceType": "manual",
            "sourceId": "",
            "url": "https://legacy.example/articles/demo",
            "status": "accepted",
            "submitted": True,
            "inclusionStatus": "indexed",
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z",
        })

    center = client.get("/api/published-center").json()
    assert center["records"] == []

    management = client.get("/api/articles?view=management").json()
    assert management["records"] == [{
        "articleId": article["id"],
        "title": article["title"],
        "keyword": "SEO",
        "status": "ready",
        "publishStatus": "not_published",
        "indexStatus": "not_submitted",
        "indexProvider": None,
        "inclusionStatus": "unchecked",
        "publishedUrl": "",
        "ruleName": "",
        "articleType": "",
        "source": "manual_ai",
        "tags": [],
        "score": article["score"],
        "updatedAt": article["updatedAt"],
    }]


def test_workflow_index_submissions_only_include_article_publication_links():
    article = client.post("/api/articles", json={"title": "Workflow Article", "keyword": "SEO", "status": "ready"}).json()
    with SessionLocal() as db:
        save_record(db, "publishJobs", {
            "id": "publish-linked",
            "articleId": article["id"],
            "articleTitle": article["title"],
            "siteId": "site-linked",
            "siteName": "Main Site",
            "connectorType": "Webhook",
            "status": "succeeded",
            "publishedUrl": "https://site.test/articles/workflow",
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z",
        })
        save_record(db, "indexSubmissions", {
            "id": "index-linked",
            "articleId": article["id"],
            "articleTitle": article["title"],
            "provider": "Google",
            "source": "published-center",
            "sourceType": "site",
            "sourceId": "publish-linked",
            "url": "https://site.test/articles/workflow",
            "status": "accepted",
            "submitted": True,
            "inclusionStatus": "unchecked",
            "createdAt": "2026-01-01T00:01:00Z",
            "updatedAt": "2026-01-01T00:01:00Z",
        })
        save_record(db, "indexSubmissions", {
            "id": "index-orphan-title-match",
            "articleTitle": article["title"],
            "provider": "Google",
            "source": "manual",
            "sourceType": "manual",
            "sourceId": "",
            "url": "https://legacy.example/articles/workflow",
            "status": "accepted",
            "submitted": True,
            "inclusionStatus": "indexed",
            "createdAt": "2026-01-01T00:02:00Z",
            "updatedAt": "2026-01-01T00:02:00Z",
        })

    raw = client.get("/api/index-submissions").json()
    workflow = client.get("/api/index-submissions?view=workflow").json()

    assert {item["id"] for item in raw} == {"index-linked", "index-orphan-title-match"}
    assert [item["id"] for item in workflow] == ["index-linked"]


def test_dashboard_metrics_includes_actionable_work_items():
    article = client.post("/api/articles", json={"title": "待索引文章", "keyword": "SEO", "status": "ready"}).json()
    site = client.post("/api/sites", json={"name": "异常站点", "type": "Webhook", "baseUrl": "https://site.test", "status": "error"}).json()
    job = client.post("/api/publish-jobs", json={"articleId": article["id"], "siteId": site["id"]}).json()
    with SessionLocal() as db:
        patch_record(db, "publishJobs", job["id"], {"status": "succeeded", "publishedUrl": "https://site.test/not-submitted"})
    client.patch(f"/api/sites/{site['id']}", json={"status": "error", "lastError": "授权失效"})
    submission = client.post("/api/index-submissions", json={
        "articleTitle": "收录异常文章",
        "articleId": article["id"],
        "url": "https://site.test/not-indexed",
        "provider": "Google",
        "sourceType": "site",
        "sourceId": job["id"],
        "inclusionStatus": "not_indexed",
    }).json()
    failed_task = client.post("/api/tasks", json={
        "type": "ai-generate-article",
        "title": "Broken AI generation",
        "queue": "ai",
        "status": "failed",
        "errorMessage": "DeepSeek timeout",
    }).json()

    metrics = client.get("/api/dashboard/metrics").json()
    work_items = metrics["operationCenter"]["workItems"]
    item_ids = {item["id"] for item in work_items}

    assert all(not item_id.startswith("pending-index:") for item_id in item_ids)
    assert f"inclusion:{submission['id']}" not in item_ids
    assert f"task:{failed_task['id']}" in item_ids
    assert all(not item_id.startswith("site-auth:") for item_id in item_ids)
    assert metrics["operationCenter"]["summary"]["authorizationExceptions"] == 0
    assert metrics["operationCenter"]["summary"]["pendingIndex"] == 0
    assert metrics["operationCenter"]["summary"]["inclusionProblems"] == 0


def test_dashboard_groups_duplicate_failures_and_hides_raw_technical_logs():
    for task_id in range(2):
        url = f"https://zhuanlan.zhihu.com/p/{259747120 + task_id}"
        client.post("/api/tasks", json={
            "type": "knowledge-refresh",
            "title": f"Refresh knowledge URL: {url}",
            "queue": "knowledge",
            "status": "failed",
            "payload": {"url": url},
            "errorMessage": (
                "scrapling-stealthy: BrowserType.launch_persistent_context: Target page, context or browser "
                f"has been closed --disable-background-networking attempt={task_id}"
            ),
        })

    client.post("/api/tasks", json={
        "type": "inclusion-check",
        "title": "Retry inclusion check: old article",
        "queue": "index",
        "status": "failed",
        "errorMessage": "DATAFORSEO_TASK_ERROR_40207: Access denied. Your IP is not whitelisted.",
    })

    metrics = client.get("/api/dashboard/metrics").json()
    work_items = metrics["operationCenter"]["workItems"]
    knowledge_items = [item for item in work_items if item.get("category") == "knowledge"]

    assert len(knowledge_items) == 1
    assert knowledge_items[0]["occurrenceCount"] == 2
    assert knowledge_items[0]["title"] == "知识库网页暂未抓取成功"
    assert knowledge_items[0]["description"] == "目标网页限制了自动访问，可以在知识库中重新抓取或改用文本、文件导入。"
    assert "BrowserType.launch" not in knowledge_items[0]["description"]
    assert all(item.get("category") != "index" for item in work_items)
    assert all("DATAFORSEO" not in item.get("description", "") for item in work_items)


def test_dashboard_groups_platform_reviews_by_article():
    article = client.post("/api/articles", json={"title": "同一篇审核文章", "status": "ready"}).json()
    order_ids = []
    for resource_name in ("企鹅号", "搜狐号"):
        order = client.post("/api/media-orders", json={
            "articleId": article["id"],
            "articleTitle": article["title"],
            "resourceId": f"resource-{resource_name}",
            "resourceName": resource_name,
        }).json()
        order_ids.append(order["id"])
    with SessionLocal() as db:
        for order_id in order_ids:
            patch_record(db, "mediaOrders", order_id, {"status": "review_required"})

    metrics = client.get("/api/dashboard/metrics").json()
    review_items = [item for item in metrics["operationCenter"]["workItems"] if item["type"] == "manual_review"]

    assert len(review_items) == 1
    assert review_items[0]["occurrenceCount"] == 2
    assert review_items[0]["description"] == "2 个平台正在处理，可在发布记录中查看各平台进度。"


def test_publish_and_index_rejects_request_thread_publish():
    article = client.post("/api/articles", json={"title": "Sync Publish", "keyword": "SEO", "status": "ready"}).json()
    site = client.post("/api/sites", json={"name": "Sync Site", "type": "Webhook", "baseUrl": "https://sync.test"}).json()

    response = client.post("/api/publish-and-index", json={
        "articleId": article["id"],
        "siteId": site["id"],
        "async": False,
        "provider": "IndexNow",
    })

    assert response.status_code == 400
    assert response.json()["detail"] == "PUBLISH_AND_INDEX_REQUIRES_QUEUE"
    assert client.get("/api/publish-jobs").json() == []
    assert client.get("/api/index-submissions").json() == []


def test_async_publish_and_index_can_enqueue_without_immediate_publish():
    article = client.post("/api/articles", json={"title": "Async Publish", "keyword": "SEO", "status": "ready"}).json()
    site = client.post("/api/sites", json={"name": "Async Site", "type": "Webhook", "baseUrl": "https://async.test"}).json()

    result = client.post("/api/publish-and-index", json={
        "articleId": article["id"],
        "siteId": site["id"],
        "async": True,
        "provider": "IndexNow",
    }).json()

    assert result["queued"] is True
    assert result["task"]["type"] == "publish-and-index"
    assert result["task"]["queue"] == "publish"
    assert client.get("/api/publish-jobs").json() == []


def test_media_order_backlink_defaults_to_queue_without_immediate_index():
    order = client.post("/api/media-orders", json={"articleTitle": "媒体回链文章", "resourceId": "resource-custom", "resourceName": "软文媒体"}).json()
    result = client.post("/api/media-orders/publish-and-index", json={"orderId": order["id"], "provider": "Google"}).json()

    assert result["queued"] is True
    assert result["task"]["type"] == "media-backlink-index"
    assert result["task"]["queue"] == "media"
    assert result["task"]["payload"]["orderId"] == order["id"]

    updated = client.get("/api/media-orders").json()[0]
    assert updated["status"] == "pending"
    assert updated["backlinkUrl"] == ""
    assert client.get("/api/index-submissions").json() == []
    center = client.get("/api/published-center").json()
    assert center["summary"]["media"] == 0


def test_media_order_backlink_rejects_request_thread_publish():
    order = client.post("/api/media-orders", json={"articleTitle": "Sync media article", "resourceName": "Media"}).json()

    response = client.post("/api/media-orders/publish-and-index", json={
        "orderId": order["id"],
        "provider": "Google",
        "async": False,
    })

    assert response.status_code == 400
    assert response.json()["detail"] == "MEDIA_BACKLINK_REQUIRES_QUEUE"
    updated = client.get("/api/media-orders").json()[0]
    assert updated["status"] == "pending"
    assert updated["backlinkUrl"] == ""
    assert client.get("/api/index-submissions").json() == []


def test_inclusion_check_defaults_to_queue_for_single_and_batch_submissions():
    first = client.post("/api/index-submissions", json={"articleTitle": "A", "url": "https://a.test", "provider": "Google"}).json()
    second = client.post("/api/index-submissions", json={"articleTitle": "B", "url": "https://b.test", "provider": "Baidu"}).json()

    queued = client.post("/api/inclusion-checks", json={"submissionId": first["id"]}).json()
    assert queued["queued"] is True
    assert queued["task"]["type"] == "inclusion-check"
    assert queued["task"]["queue"] == "index"
    assert queued["task"]["payload"]["submissionId"] == first["id"]
    assert client.get(f"/api/index-submissions/{first['id']}").json()["submission"]["inclusionStatus"] == "unchecked"

    batch = client.post("/api/inclusion-checks", json={"submissionIds": [first["id"], second["id"]]}).json()
    assert batch["queued"] is True
    assert len(batch["tasks"]) == 2
    assert {task["payload"]["submissionId"] for task in batch["tasks"]} == {first["id"], second["id"]}
    submissions = client.get("/api/index-submissions").json()
    assert {item["inclusionStatus"] for item in submissions} == {"unchecked"}


def test_inclusion_check_rejects_request_thread_detection():
    submission = client.post("/api/index-submissions", json={"articleTitle": "A", "url": "https://a.test", "provider": "Google"}).json()

    response = client.post("/api/inclusion-checks", json={"submissionId": submission["id"], "async": False})

    assert response.status_code == 400
    assert response.json()["detail"] == "INCLUSION_CHECK_REQUIRES_QUEUE"
    assert client.get(f"/api/index-submissions/{submission['id']}").json()["submission"]["inclusionStatus"] == "unchecked"


def test_async_inclusion_check_queues_worker_task():
    submission = client.post("/api/index-submissions", json={"articleTitle": "A", "url": "https://a.test", "provider": "Google"}).json()

    result = client.post("/api/inclusion-checks", json={"submissionId": submission["id"], "async": True}).json()

    assert result["queued"] is True
    assert result["task"]["type"] == "inclusion-check"
    assert result["task"]["queue"] == "index"


def test_retry_index_submission_reuses_record_and_queues_provider_work():
    with SessionLocal() as db:
        submission = save_record(db, "indexSubmissions", {
            "id": "index-retry-provider",
            "articleTitle": "Retry provider",
            "url": "https://example.com/articles/retry-provider",
            "provider": "IndexNow",
            "status": "provider_pending",
            "submitted": False,
            "inclusionStatus": "unchecked",
        })

    result = client.post(f"/api/index-submissions/{submission['id']}/retry").json()

    assert result["id"] == submission["id"]
    assert result["status"] == "pending"
    assert result["queued"] is True
    task = client.get(f"/api/tasks/{result['taskId']}").json()
    assert task["type"] == "index-submit"
    assert task["payload"]["submissionId"] == submission["id"]


def test_manual_index_submission_starts_pending_and_queues_real_provider_work():
    result = client.post("/api/index-submissions", json={
        "articleTitle": "Real provider submission",
        "url": "https://example.com/articles/real-provider",
        "provider": "Google",
    }).json()

    assert result["status"] == "pending"
    assert result["submitted"] is False
    assert result["queued"] is True
    task = client.get(f"/api/tasks/{result['taskId']}").json()
    assert task["type"] == "index-submit"
    assert task["queue"] == "index"
    assert task["payload"]["submissionId"] == result["id"]
    detail = client.get(f"/api/index-submissions/{result['id']}").json()
    assert detail["timeline"][0]["status"] == "pending"
    assert detail["nextActions"][0]["action"] == "retry-submit"
    assert len(client.get("/api/index-submissions").json()) == 1
    assert client.get("/api/index-submissions?view=workflow").json() == []
    metrics = client.get("/api/dashboard/metrics").json()
    assert metrics["indexRecords"] == 0
    assert metrics["submittedIndexes"] == 0


def test_invalid_index_submission_does_not_leave_orphan_record():
    response = client.post("/api/index-submissions", json={
        "articleTitle": "Missing URL",
        "provider": "Google",
    })

    assert response.status_code == 400
    assert response.json()["detail"] == "INDEX_URL_REQUIRED"
    assert client.get("/api/index-submissions").json() == []


def test_pending_index_record_is_not_a_dashboard_work_item():
    published_url = "https://example.com/articles/provider-pending"
    article = client.post("/api/articles", json={
        "title": "Published but provider pending",
        "status": "published",
    }).json()
    with SessionLocal() as db:
        patch_record(db, "articles", article["id"], {"status": "published", "publishedUrl": published_url})
    client.post("/api/index-submissions", json={
        "articleId": article["id"],
        "articleTitle": article["title"],
        "url": published_url,
        "provider": "Google",
    })

    dashboard = client.get("/api/dashboard/metrics").json()

    assert all(item["type"] != "index_pending" for item in dashboard["operationCenter"]["workItems"])


def test_published_detail_does_not_label_pending_provider_work_as_submitted():
    article = client.post("/api/articles", json={"title": "Pending index publication", "keyword": "SEO", "status": "ready"}).json()
    with SessionLocal() as db:
        job = save_record(db, "publishJobs", {
            "id": "publish-pending-index",
            "articleId": article["id"],
            "articleTitle": "Pending index publication",
            "siteName": "Main site",
            "connectorType": "WordPress",
            "status": "succeeded",
            "publishedUrl": "https://example.com/articles/pending-index",
            "updatedAt": "07/12 15:00",
        })
        save_record(db, "indexSubmissions", {
            "id": "index-pending-publication",
            "articleId": article["id"],
            "articleTitle": job["articleTitle"],
            "provider": "Google",
            "sourceType": "site",
            "sourceId": job["id"],
            "url": job["publishedUrl"],
            "status": "pending",
            "submitted": False,
            "inclusionStatus": "unchecked",
        })

    detail = client.get(f"/api/published-center/site:{job['id']}").json()

    index_item = next(item for item in detail["timeline"] if item["type"] == "index_submitted")
    assert index_item["status"] == "pending"
    assert detail["record"]["indexStatus"] == "pending"


def test_indexer_get_and_post_routes_are_not_shadowed_by_generic_resources(monkeypatch):
    class FakeSearchIndexService:
        def statuses(self):
            return [
                {
                    "provider": provider,
                    "configured": False,
                    "status": "provider_pending",
                    "missingFields": [f"{provider.upper()}_CREDENTIALS"],
                    "submissionMethod": "provider_api",
                    "submissionCapability": "owned_site_only",
                    "inspectionCapability": "unavailable",
                    "observationConfigured": False,
                    "setupHint": "Configure environment credentials.",
                }
                for provider in ["Google", "Baidu", "IndexNow", "Sitemap"]
            ]

    monkeypatch.setattr(main_module, "SearchIndexService", FakeSearchIndexService)
    center_response = client.get("/api/indexers?view=center")

    assert center_response.status_code == 200
    center = center_response.json()
    assert {config["provider"] for config in center["configs"]} == {"Google", "Baidu", "IndexNow", "Sitemap", "DataForSEO"}
    assert center["summary"]["total"] == 5
    assert center["summary"]["authorized"] == 0
    assert all(config["authorized"] is False for config in center["configs"])
    assert all(config.get("missingFields") for config in center["configs"] if config["provider"] != "DataForSEO")

    authorized_response = client.post("/api/indexers", json={
        "provider": "IndexNow",
        "name": "Primary IndexNow",
        "autoSubmit": True,
    })

    assert authorized_response.status_code == 200
    authorized = authorized_response.json()
    assert authorized["provider"] == "IndexNow"
    assert authorized["authorized"] is False
    assert authorized["configured"] is False
    assert authorized["autoSubmit"] is True


def test_indexer_route_rejects_plaintext_credentials():
    response = client.post("/api/indexers", json={
        "provider": "Baidu",
        "authKey": "must-not-be-persisted",
    })

    assert response.status_code == 400
    assert response.json()["detail"] == "INDEX_CREDENTIALS_ENV_ONLY"
    with SessionLocal() as db:
        assert all("authKey" not in item for item in list_records(db, "indexerConfigs"))


def test_dashboard_uses_runtime_indexer_configuration_instead_of_stored_authorized_flag(monkeypatch):
    class ConfiguredSearchIndexService:
        def statuses(self):
            return [
                {
                    "provider": provider,
                    "configured": True,
                    "status": "active",
                    "missingFields": [],
                    "configurationErrors": [],
                    "submissionMethod": "provider_api",
                    "submissionCapability": "owned_site_only",
                    "inspectionCapability": "official_owned_site",
                    "observationConfigured": True,
                    "setupHint": "Ready",
                }
                for provider in ["Google", "Baidu", "IndexNow", "Sitemap"]
            ]

    monkeypatch.setattr(main_module, "SearchIndexService", ConfiguredSearchIndexService)
    client.get("/api/indexers?view=center")

    dashboard = client.get("/api/dashboard/metrics").json()

    assert dashboard["operationCenter"]["summary"]["authorizationExceptions"] == 0


def test_indexer_retry_queues_inclusion_checks_without_running_in_request():
    first = client.post("/api/index-submissions", json={
        "articleTitle": "Retry A",
        "url": "https://a.test/retry",
        "provider": "Google",
        "inclusionStatus": "not_indexed",
    }).json()
    second = client.post("/api/index-submissions", json={
        "articleTitle": "Retry B",
        "url": "https://b.test/retry",
        "provider": "Google",
        "inclusionStatus": "failed",
    }).json()
    client.post("/api/index-submissions", json={
        "articleTitle": "Skip Baidu",
        "url": "https://baidu.test/retry",
        "provider": "Baidu",
        "inclusionStatus": "failed",
    })

    result = client.put("/api/indexers", json={"provider": "Google"}).json()

    assert result["queued"] is True
    assert result["retried"] == 2
    assert len(result["tasks"]) == 2
    assert {task["type"] for task in result["tasks"]} == {"inclusion-check"}
    assert {task["queue"] for task in result["tasks"]} == {"index"}
    task_payloads = [task["payload"] for task in result["tasks"]]
    assert {payload["submissionId"] for payload in task_payloads} == {first["id"], second["id"]}
    submissions = {item["id"]: item for item in client.get("/api/index-submissions").json()}
    assert submissions[first["id"]]["inclusionStatus"] == "not_indexed"
    assert submissions[second["id"]]["inclusionStatus"] == "failed"


def test_batch_submit_index_is_disabled():
    article = client.post("/api/articles", json={"title": "Batch Article", "keyword": "SEO", "status": "ready"}).json()
    site = client.post("/api/sites", json={"name": "Batch Site", "baseUrl": "https://example.com"}).json()
    job = client.post("/api/publish-jobs", json={"articleId": article["id"], "siteId": site["id"]}).json()
    with SessionLocal() as db:
        patch_record(db, "publishJobs", job["id"], {"status": "succeeded", "publishedUrl": "https://example.com/articles/batch-article"})
    job = {**job, "status": "succeeded", "publishedUrl": "https://example.com/articles/batch-article"}

    response = client.post("/api/batch-operations", json={
        "recordIds": [f"site:{job['id']}"],
        "action": "submit-index",
        "provider": "IndexNow",
        "checkImmediately": True,
    })

    assert response.status_code == 400
    assert response.json()["detail"] == "INDEX_SUBMISSION_DISABLED"
    assert client.get("/api/index-submissions").json() == []


def test_batch_check_inclusion_queues_tasks_without_checking_in_request():
    article = client.post("/api/articles", json={"title": "Batch Inclusion", "status": "ready"}).json()
    job = client.post("/api/publish-jobs", json={
        "articleId": article["id"],
        "siteId": client.post("/api/sites", json={"name": "Site", "baseUrl": "https://example.com"}).json()["id"],
    }).json()
    with SessionLocal() as db:
        patch_record(db, "publishJobs", job["id"], {"status": "succeeded", "publishedUrl": "https://example.com/articles/batch-inclusion"})
    submission = client.post("/api/index-submissions", json={
        "articleId": article["id"],
        "articleTitle": "Batch Inclusion",
        "url": "https://example.com/articles/batch-inclusion",
        "provider": "Google",
        "sourceType": "site",
        "sourceId": job["id"],
        "inclusionStatus": "unchecked",
    }).json()

    result = client.post("/api/batch-operations", json={
        "recordIds": [f"site:{job['id']}"],
        "action": "check-inclusion",
    }).json()

    assert result["queued"] is True
    assert result["checked"] == 1
    assert len(result["tasks"]) == 1
    assert result["tasks"][0]["type"] == "inclusion-check"
    assert result["tasks"][0]["queue"] == "index"
    assert result["tasks"][0]["payload"]["submissionId"] == submission["id"]
    updated = client.get(f"/api/index-submissions/{submission['id']}").json()["submission"]
    assert updated["inclusionStatus"] == "unchecked"


def test_generate_article_defaults_to_queue_with_writer_context_rules_knowledge_and_assets():
    rule = client.post("/api/generation-rules", json={"name": "Product SEO Rule", "content": "Write as a comparison guide."}).json()
    knowledge = client.post("/api/knowledge-base", json={"title": "Brand Facts", "content": "Zhixin AI helps SEO teams publish at scale.", "tags": ["brand"]}).json()
    asset = client.post("/api/assets", json={"filename": "hero.png", "altText": "AI SEO dashboard", "tags": ["hero"]}).json()
    brand = client.post("/api/brand-library", json={"name": "Zhixin AI", "tags": ["seo", "automation"]}).json()
    competitor = client.post("/api/competitor-library", json={"name": "Kuaijing SEO", "strengths": ["publishing"]}).json()

    result = client.post("/api/articles/generate", json={
        "keyword": "AI SEO platform",
        "writerContext": {"audience": "SEO operators", "tone": "practical"},
        "ruleId": rule["id"],
        "knowledgeIds": [knowledge["id"]],
        "assetIds": [asset["id"]],
    }).json()

    assert result["queued"] is True
    assert result["task"]["type"] == "ai-generate-article"
    assert result["task"]["queue"] == "ai"
    assert result["task"]["payload"]["keyword"] == "AI SEO platform"
    assert result["task"]["payload"]["writerContext"]["audience"] == "SEO operators"
    assert result["task"]["payload"]["ruleId"] == rule["id"]
    assert result["task"]["payload"]["knowledgeIds"] == [knowledge["id"]]
    assert result["task"]["payload"]["assetIds"] == [asset["id"]]
    assert client.get("/api/articles").json() == []
    assert client.get("/api/llm-requests").json() == []


def test_generate_article_rejects_request_thread_llm_generation():
    response = client.post("/api/articles/generate", json={
        "keyword": "Synchronous AI SEO",
        "async": False,
    })

    assert response.status_code == 400
    assert response.json()["detail"] == "AI_GENERATION_REQUIRES_QUEUE"
    assert client.get("/api/articles").json() == []
    assert client.get("/api/llm-requests").json() == []


def test_async_generate_article_queues_without_creating_article_immediately():
    rule = client.post("/api/generation-rules", json={"name": "Async Rule", "content": "Use queued generation."}).json()
    knowledge = client.post("/api/knowledge-base", json={"title": "Async Facts", "content": "Queued context."}).json()
    asset = client.post("/api/assets", json={"filename": "async.png", "altText": "Queued asset"}).json()

    result = client.post("/api/articles/generate", json={
        "keyword": "Queued AI SEO",
        "async": True,
        "writerContext": {"audience": "operators"},
        "ruleId": rule["id"],
        "knowledgeIds": [knowledge["id"]],
        "assetIds": [asset["id"]],
    }).json()

    assert result["queued"] is True
    assert result["task"]["type"] == "ai-generate-article"
    assert result["task"]["queue"] == "ai"
    assert result["task"]["payload"]["writerContext"]["audience"] == "operators"
    assert result["task"]["payload"]["ruleId"] == rule["id"]
    assert client.get("/api/articles").json() == []


def test_creation_history_links_ai_task_result_article():
    article = client.post("/api/articles", json={
        "title": "Docker SEO generated article",
        "keyword": "Docker SEO",
        "status": "ready",
        "source": "deepseek_ai",
    }).json()
    task = client.post("/api/tasks", json={
        "type": "ai-generate-article",
        "title": "AI article generation: Docker SEO",
        "queue": "ai",
        "status": "succeeded",
        "payload": {
            "keyword": "Docker SEO",
            "ruleName": "DeepSeek Rule",
            "writerContext": {"mode": "normal"},
        },
        "result": {"articleId": article["id"]},
    }).json()
    llm_request = client.post("/api/llm-requests", json={
        "provider": "deepseek",
        "model": "deepseek-v4-pro",
        "status": "succeeded",
        "articleId": article["id"],
        "taskId": task["id"],
    }).json()

    history = client.get("/api/creation-history").json()
    record = next(item for item in history["tasks"] if item["id"] == task["id"])

    assert llm_request["taskId"] == task["id"]
    assert record["articleCount"] == 1
    assert record["readyCount"] == 1
    assert record["articles"][0]["articleId"] == article["id"]


def test_publish_from_context_can_queue_site_publish_without_running_immediately():
    article = client.post("/api/articles", json={"title": "Queued Site Publish", "keyword": "SEO", "status": "ready"}).json()
    site = client.post("/api/sites", json={"name": "Main Site", "type": "Webhook", "baseUrl": "https://site.test"}).json()

    result = client.post(f"/api/articles/{article['id']}/publish-from-context", json={
        "targetId": f"site:{site['id']}",
        "provider": "IndexNow",
        "checkImmediately": True,
    }).json()

    assert result["queued"] is True
    assert result["channel"] == "site"
    assert result["targetId"] == site["id"]
    assert result["task"]["type"] == "publish-and-index"
    assert result["task"]["queue"] == "publish"
    assert result["task"]["payload"]["articleId"] == article["id"]
    assert result["task"]["payload"]["siteId"] == site["id"]
    assert result["task"]["payload"]["submitIndex"] is False
    assert result["task"]["payload"]["checkImmediately"] is True
    assert client.get("/api/publish-jobs").json() == []
    assert client.get("/api/index-submissions").json() == []


def test_published_article_cannot_be_edited_or_republished():
    article = client.post("/api/articles", json={
        "title": "Already Published",
        "keyword": "SEO",
        "status": "ready",
        "contentMarkdown": "# Already Published\n\nbody",
    }).json()
    # Simulate successful public publish writeback (bypasses locked PATCH).
    with SessionLocal() as db:
        article = patch_record(db, "articles", article["id"], {
            "status": "published",
            "publishedUrl": "https://zhuanlan.zhihu.com/p/locked-article",
            "publishStatus": "published",
        })
    site = client.post("/api/sites", json={"name": "Lock Site", "type": "Webhook", "baseUrl": "https://lock.test"}).json()

    patch = client.patch(f"/api/articles/{article['id']}", json={
        "title": "Should Not Change",
        "contentMarkdown": "# hacked",
        "status": "ready",
    })
    assert patch.status_code == 409
    assert patch.json()["detail"] == "ARTICLE_PUBLISHED_LOCKED"

    republish = client.post(f"/api/articles/{article['id']}/publish-from-context", json={
        "targetId": f"site:{site['id']}",
        "provider": "IndexNow",
        "async": True,
    })
    assert republish.status_code == 409
    assert republish.json()["detail"] == "ARTICLE_ALREADY_PUBLISHED"

    frozen = client.get(f"/api/articles/{article['id']}").json()
    assert frozen["title"] == "Already Published"
    assert frozen["status"] == "published"
    assert frozen.get("publishedUrl") == "https://zhuanlan.zhihu.com/p/locked-article"



def test_article_allows_only_one_non_failed_media_publish_attempt():
    device = client.post("/api/desktop-devices/register", json={
        "deviceName": "Single publish device",
        "platform": "windows",
        "appVersion": "0.1.0",
        "publicKey": "single-publish-device-key",
    }).json()
    authorized = complete_media_authorization(
        device,
        platform="zhihu",
        account_name="Single publish account",
        fingerprint="single-publish-account",
    )
    article = client.post("/api/articles", json={
        "title": "Single publish article",
        "keyword": "single publish",
        "status": "ready",
        "contentMarkdown": "# Single publish article\n\nBody",
    }).json()

    first = client.post(f"/api/articles/{article['id']}/publish-from-context", json={
        "targetId": f"media:{authorized['mediaAccount']['id']}",
        "confirmPublish": True,
    })

    assert first.status_code == 200
    first_result = first.json()
    assert first_result["mediaOrder"]["status"] == "pending"
    assert first_result["mediaOrder"]["articleId"] == article["id"]
    assert client.get(f"/api/articles/{article['id']}").json()["publishStatus"] == "pending"

    duplicate = client.post(f"/api/articles/{article['id']}/publish-from-context", json={
        "targetId": f"media:{authorized['mediaAccount']['id']}",
        "confirmPublish": True,
    })
    assert duplicate.status_code == 409
    assert duplicate.json()["detail"]["code"] == "ARTICLE_PUBLISH_ALREADY_ACTIVE"

    failed = client.post(
        f"/api/desktop-commands/{first_result['desktopCommand']['id']}/events",
        json={
            "deviceId": device["device"]["id"],
            "deviceToken": device["deviceToken"],
            "type": "publish_failed",
            "payload": {"errorMessage": "PLATFORM_REJECTED"},
        },
    )
    assert failed.status_code == 200
    assert failed.json()["mediaOrder"]["status"] == "failed"
    assert client.get(f"/api/articles/{article['id']}").json()["publishStatus"] == "failed"

    retry = client.post(f"/api/articles/{article['id']}/publish-from-context", json={
        "targetId": f"media:{authorized['mediaAccount']['id']}",
        "confirmPublish": True,
    })
    assert retry.status_code == 200
    retry_payload = retry.json()
    assert retry_payload["mediaOrder"]["id"] == first_result["mediaOrder"]["id"]
    assert retry_payload["mediaOrder"]["attempt"] == 2
    assert retry_payload["mediaOrder"]["sourceCommandId"] == retry_payload["desktopCommand"]["id"]
    raw_orders = [
        item for item in client.get("/api/media-orders").json()
        if item["articleId"] == article["id"]
    ]
    assert len(raw_orders) == 1
    records = [
        item for item in client.get("/api/published-center").json()["records"]
        if item["articleId"] == article["id"]
    ]
    assert len(records) == 1
    assert records[0]["sourceId"] == retry_payload["mediaOrder"]["id"]


def test_publish_failed_with_accepted_platform_status_stays_in_review_not_failed():
    """A platform-accepted article (CSDN status=6 under review) reported via publish_failed."""
    device = client.post("/api/desktop-devices/register", json={
        "deviceName": "CSDN accepted platform device",
        "platform": "windows",
        "appVersion": "0.1.0",
        "publicKey": "csdn-accepted-platform-key",
    }).json()
    authorized = complete_media_authorization(
        device,
        platform="csdn",
        account_name="CSDN accepted account",
        fingerprint="csdn-accepted-account",
    )
    article = client.post("/api/articles", json={
        "title": "CSDN article accepted but reported as failed",
        "keyword": "csdn accepted",
        "status": "ready",
        "contentMarkdown": "# CSDN article\n\nThe article reached the platform under review.",
    }).json()
    first = client.post(f"/api/articles/{article['id']}/publish-from-context", json={
        "targetId": f"media:{authorized['mediaAccount']['id']}",
        "confirmPublish": True,
    }).json()

    failed = client.post(
        f"/api/desktop-commands/{first['desktopCommand']['id']}/events",
        json={
            "deviceId": device["device"]["id"],
            "deviceToken": device["deviceToken"],
            "type": "publish_failed",
            "payload": {
                "platformStatus": "submitted_for_review",
                "reviewUrl": "https://blog.csdn.net/m0_00000/article/details/167131744",
                "errorMessage": "CSDN_API_PUBLICATION_NOT_VERIFIED",
                "message": "Article created on CSDN and queued for platform review.",
            },
        },
    ).json()

    assert failed["command"]["status"] == "failed"
    assert failed["mediaOrder"]["status"] == "review_required"
    assert failed["mediaOrder"]["platformStatus"] == "submitted_for_review"
    assert failed["mediaOrder"]["backlinkStatus"] == "reviewing"
    assert failed["mediaOrder"]["reviewUrl"] == "https://blog.csdn.net/m0_00000/article/details/167131744"
    article_after = client.get(f"/api/articles/{article['id']}").json()
    assert article_after["publishStatus"] == "submitted_for_review"


def test_article_can_publish_to_each_media_account_once_without_global_media_lock():
    device = client.post("/api/desktop-devices/register", json={
        "deviceName": "Multi platform device",
        "platform": "windows",
        "appVersion": "0.1.0",
        "publicKey": "multi-platform-device-key",
    }).json()
    zhihu = complete_media_authorization(
        device,
        platform="zhihu",
        account_name="Multi platform zhihu",
        fingerprint="multi-platform-zhihu",
    )
    sohu = complete_media_authorization(
        device,
        platform="sohu",
        account_name="Multi platform sohu",
        fingerprint="multi-platform-sohu",
    )
    article = client.post("/api/articles", json={
        "title": "Multi platform article",
        "keyword": "multi platform",
        "status": "ready",
        "contentMarkdown": "# Multi platform article\n\nBody",
    }).json()

    first = client.post(f"/api/articles/{article['id']}/publish-from-context", json={
        "targetId": f"media:{zhihu['mediaAccount']['id']}",
        "confirmPublish": True,
    })
    second = client.post(f"/api/articles/{article['id']}/publish-from-context", json={
        "targetId": f"media:{sohu['mediaAccount']['id']}",
        "confirmPublish": True,
    })
    duplicate = client.post(f"/api/articles/{article['id']}/publish-from-context", json={
        "targetId": f"media:{zhihu['mediaAccount']['id']}",
        "confirmPublish": True,
    })

    assert first.status_code == 200
    assert second.status_code == 200
    assert duplicate.status_code == 409
    assert duplicate.json()["detail"]["code"] == "ARTICLE_PUBLISH_ALREADY_ACTIVE"
    orders = [
        item for item in client.get("/api/media-orders").json()
        if item["articleId"] == article["id"]
    ]
    assert {(item["mediaAccountId"], item["status"]) for item in orders} == {
        (zhihu["mediaAccount"]["id"], "pending"),
        (sohu["mediaAccount"]["id"], "pending"),
    }


def test_article_cannot_be_republished_while_platform_review_is_pending():
    device = client.post("/api/desktop-devices/register", json={
        "deviceName": "Review lock device",
        "platform": "windows",
        "appVersion": "0.1.0",
        "publicKey": "review-lock-device-key",
    }).json()
    authorized = complete_media_authorization(
        device,
        platform="sohu",
        account_name="Review lock account",
        fingerprint="review-lock-account",
    )
    article = client.post("/api/articles", json={
        "title": "Review locked article",
        "keyword": "review lock",
        "status": "ready",
    }).json()
    queued = client.post(f"/api/articles/{article['id']}/publish-from-context", json={
        "targetId": f"media:{authorized['mediaAccount']['id']}",
        "confirmPublish": True,
    }).json()

    reviewed = client.post(
        f"/api/desktop-commands/{queued['desktopCommand']['id']}/events",
        json={
            "deviceId": device["device"]["id"],
            "deviceToken": device["deviceToken"],
            "type": "publish_succeeded",
            "payload": {
                "reviewUrl": "https://mp.sohu.com/review/article-1",
                "platformStatus": "submitted_for_review",
                "publiclyVisible": False,
            },
        },
    )
    assert reviewed.status_code == 200
    assert reviewed.json()["mediaOrder"]["status"] == "review_required"
    assert reviewed.json()["mediaOrder"]["sourceCommandId"] == queued["desktopCommand"]["id"]
    assert reviewed.json()["mediaOrder"]["attempt"] == queued["mediaOrder"]["attempt"]
    assert reviewed.json()["mediaOrder"]["createdAt"] == queued["mediaOrder"]["createdAt"]

    duplicate = client.post(f"/api/articles/{article['id']}/publish-from-context", json={
        "targetId": f"media:{authorized['mediaAccount']['id']}",
        "confirmPublish": True,
    })
    assert duplicate.status_code == 409
    assert duplicate.json()["detail"]["code"] == "ARTICLE_PUBLISH_ALREADY_ACTIVE"


def test_published_center_keeps_only_latest_record_for_each_article():
    article = client.post("/api/articles", json={
        "title": "One current publication record",
        "keyword": "publication record",
        "status": "ready",
    }).json()
    client.post("/api/media-orders", json={
        "id": "media-order-older-review",
        "articleId": article["id"],
        "articleTitle": article["title"],
        "resourceId": "account:media-account-old",
        "resourceName": "Old account",
        "status": "review_required",
        "reviewUrl": "https://creator.example/older",
        "updatedAt": "07/20 10:00",
    })
    client.post("/api/media-orders", json={
        "id": "media-order-newer-review",
        "articleId": article["id"],
        "articleTitle": article["title"],
        "resourceId": "account:media-account-new",
        "resourceName": "New account",
        "status": "review_required",
        "reviewUrl": "https://creator.example/newer",
        "updatedAt": "07/21 10:00",
    })

    records = [
        item for item in client.get("/api/published-center").json()["records"]
        if item["articleId"] == article["id"]
    ]
    assert len(records) == 1
    assert records[0]["sourceId"] == "media-order-newer-review"
def test_desktop_device_verify_requires_the_current_device_token():
    device = client.post("/api/desktop-devices/register", json={
        "deviceName": "Windows Workstation",
        "platform": "windows",
        "appVersion": "0.1.0",
        "publicKey": "desktop-public-key",
    }).json()

    verified = client.post(
        f"/api/desktop-devices/{device['device']['id']}/verify",
        json={"deviceToken": device["deviceToken"]},
    )
    rejected = client.post(
        f"/api/desktop-devices/{device['device']['id']}/verify",
        json={"deviceToken": "stale-token"},
    )

    assert verified.status_code == 200
    assert verified.json()["device"]["id"] == device["device"]["id"]
    assert rejected.status_code == 403
    assert rejected.json()["detail"] == "DESKTOP_DEVICE_AUTH_REQUIRED"


def test_publish_from_context_can_queue_desktop_media_publish_command():
    article = client.post("/api/articles", json={
        "title": "Queued Media Publish",
        "keyword": "SEO",
        "summary": "Queued summary",
        "contentMarkdown": "Queued media publish body",
        "status": "ready",
    }).json()
    device = client.post("/api/desktop-devices/register", json={
        "deviceName": "Windows Workstation",
        "platform": "windows",
        "appVersion": "0.1.0",
        "publicKey": "desktop-public-key",
    }).json()
    created = client.post("/api/media-auth-sessions", json={
        "platform": "zhihu",
        "deviceId": device["device"]["id"],
    }).json()
    session = created["session"]
    client.post(
        f"/api/desktop-devices/{device['device']['id']}/media-auth-sessions/{session['id']}/claim",
        json={"pairingCode": session["pairingCode"], "deviceToken": device["deviceToken"]},
    )
    client.post(f"/api/media-auth-sessions/{session['id']}/artifacts", json={
        "deviceId": device["device"]["id"],
        "accountName": "Zhihu Account",
        "artifact": {
            "cookies": "encrypted-cookie-payload",
            "localStorage": "encrypted-local-storage",
            "sessionStorage": "encrypted-session-storage",
            "fingerprint": "sha256-demo-fingerprint",
            "authorizationEvidence": {
                "strongCookiePresent": True,
                "workspaceReady": True,
                "currentUrl": "https://www.zhihu.com/creator",
                "pageTitle": "Zhihu creator center",
            },
        },
    })
    account = client.post(f"/api/media-auth-sessions/{session['id']}/bind", json={"name": "Zhihu Account"}).json()["mediaAccount"]

    result = client.post(f"/api/articles/{article['id']}/publish-from-context", json={
        "targetId": f"media:{account['id']}",
        "provider": "Google",
        "checkImmediately": False,
        "confirmPublish": True,
    }).json()

    assert result["queued"] is True
    assert result["channel"] == "free-media"
    assert result["targetId"] == account["id"]
    assert result["mediaOrder"]['status'] == "pending"
    assert result["mediaOrder"]['articleId'] == article['id']
    assert result["task"] is None
    assert result["desktopCommand"]["type"] == "publish_article"
    assert result["desktopCommand"]["mediaAccountId"] == account["id"]
    assert result["desktopCommand"]["payload"]["articleId"] == article["id"]
    assert result["desktopCommand"]["payload"]["platform"] == "zhihu"
    assert result["desktopCommand"]["payload"]["sessionId"] == session["id"]
    assert result["desktopCommand"]["payload"]["accountName"] == "Zhihu Account"
    assert result["desktopCommand"]["payload"]["articleTitle"] == "Queued Media Publish"
    assert result["desktopCommand"]["payload"]["contentMarkdown"] == "Queued media publish body"
    assert result["desktopCommand"]["payload"]["confirmPublish"] is True
    assert result["desktopCommand"]["payload"]["submitIndex"] is False
    assert result["desktopCommand"]["payload"]["headless"] is True
    assert result["desktopCommand"]["payload"]["keepBrowserOpen"] is False
    assert result["desktopCommand"]["payload"]["allowForeground"] is False
    assert client.get("/api/index-submissions").json() == []

    completed = client.post(f"/api/desktop-commands/{result['desktopCommand']['id']}/events", json={
        "deviceId": device["device"]["id"],
        "deviceToken": device["deviceToken"],
        "type": "publish_succeeded",
        "payload": {
            "publishedUrl": "https://zhuanlan.zhihu.com/p/987654321",
            "platformStatus": "published",
        },
    }).json()
    assert completed["command"]["status"] == "succeeded"
    assert completed["mediaOrder"]["articleId"] == article["id"]
    assert completed["indexSubmission"] is None
    center_record = next(item for item in client.get("/api/published-center").json()["records"] if item["sourceId"] == completed["mediaOrder"]["id"])
    assert center_record["articleId"] == article["id"]


def queue_illustrated_media_publish(title: str):
    article = client.post("/api/articles", json={
        "title": title,
        "keyword": "图文发布",
        "summary": "图文发布证据测试",
        "contentMarkdown": "## 第一节\n\n正文\n\n![第一节插图](/uploads/assets/inline.png)",
        "contentBlocks": [
            {"type": "section", "sectionId": "first", "title": "第一节", "content": "正文"},
            {"type": "image", "assetId": "asset-inline", "sectionId": "first", "url": "/uploads/assets/inline.png", "altText": "第一节插图"},
        ],
        "inlineImages": [
            {"assetId": "asset-inline", "sectionId": "first", "url": "/uploads/assets/inline.png", "altText": "第一节插图"},
        ],
        "status": "ready",
    }).json()
    with SessionLocal() as db:
        article = patch_record(db, "articles", article["id"], {
            "sections": [
                {"id": "first", "title": "第一节", "content": "正文"},
            ],
            "contentBlocks": [
                {"type": "section", "sectionId": "first", "title": "第一节", "content": "正文"},
                {"type": "image", "assetId": "asset-inline", "sectionId": "first", "url": "/uploads/assets/inline.png", "altText": "第一节插图"},
            ],
            "inlineImages": [
                {"assetId": "asset-inline", "sectionId": "first", "url": "/uploads/assets/inline.png", "altText": "第一节插图"},
            ],
        })
    device = client.post("/api/desktop-devices/register", json={
        "deviceName": f"{title} workstation",
        "platform": "windows",
        "appVersion": "0.1.0",
        "publicKey": f"public-key-{title}",
    }).json()
    session = client.post("/api/media-auth-sessions", json={
        "platform": "zhihu",
        "deviceId": device["device"]["id"],
    }).json()["session"]
    client.post(
        f"/api/desktop-devices/{device['device']['id']}/media-auth-sessions/{session['id']}/claim",
        json={"pairingCode": session["pairingCode"], "deviceToken": device["deviceToken"]},
    )
    client.post(f"/api/media-auth-sessions/{session['id']}/artifacts", json={
        "deviceId": device["device"]["id"],
        "accountName": title,
        "artifact": {
            "cookies": "encrypted-cookie-payload",
            "localStorage": "encrypted-local-storage",
            "sessionStorage": "encrypted-session-storage",
            "fingerprint": f"fingerprint-{title}",
            "authorizationEvidence": {
                "strongCookiePresent": True,
                "workspaceReady": True,
                "currentUrl": "https://www.zhihu.com/creator",
                "pageTitle": "Zhihu creator center",
            },
        },
    })
    account = client.post(f"/api/media-auth-sessions/{session['id']}/bind", json={"name": title}).json()["mediaAccount"]
    queued = client.post(f"/api/articles/{article['id']}/publish-from-context", json={
        "targetId": f"media:{account['id']}",
        "provider": "Google",
        "checkImmediately": False,
        "confirmPublish": True,
    }).json()
    return article, device, queued


def illustrated_image_evidence(public_images=True):
    image = {
        "assetId": "asset-inline",
        "sectionId": "first",
        "position": 2,
        "platformImageUrl": "https://pic.zhimg.com/platform-inline.png",
        "loaded": True,
    }
    public = [image] if public_images else []
    return {
        "version": 1,
        "status": "verified" if public_images else "review_required",
        "expectedCount": 1,
        "upload": {"status": "verified", "verifiedCount": 1, "images": [image]},
        "draft": {"status": "verified", "verifiedCount": 1, "images": [image]},
        "public": {"status": "verified" if public_images else "failed", "verifiedCount": len(public), "images": public},
        "issues": [] if public_images else ["PUBLIC_IMAGE_MISSING"],
    }


def test_publish_event_persists_verified_image_evidence():
    article, device, queued = queue_illustrated_media_publish("Illustrated verified publication")
    evidence = illustrated_image_evidence()

    completed = client.post(f"/api/desktop-commands/{queued['desktopCommand']['id']}/events", json={
        "deviceId": device["device"]["id"],
        "deviceToken": device["deviceToken"],
        "type": "publish_succeeded",
        "payload": {
            "publishedUrl": "https://zhuanlan.zhihu.com/p/100000001",
            "platformStatus": "published",
            "imagePublicationEvidence": evidence,
        },
    }).json()

    assert completed["mediaOrder"]["status"] == "succeeded"
    assert completed["mediaOrder"]["imagePublicationEvidence"] == evidence
    assert completed["indexSubmission"] is None


def test_publish_event_blocks_public_url_when_platform_image_evidence_is_incomplete():
    article, device, queued = queue_illustrated_media_publish("Illustrated incomplete publication")
    evidence = illustrated_image_evidence(public_images=False)

    completed = client.post(f"/api/desktop-commands/{queued['desktopCommand']['id']}/events", json={
        "deviceId": device["device"]["id"],
        "deviceToken": device["deviceToken"],
        "type": "publish_succeeded",
        "payload": {
            "publishedUrl": "https://zhuanlan.zhihu.com/p/100000002",
            "platformStatus": "published",
            "imagePublicationEvidence": evidence,
        },
    }).json()

    assert completed["mediaOrder"]["status"] == "review_required"
    assert completed["mediaOrder"]["backlinkUrl"] == ""
    assert completed["mediaOrder"]["reviewUrl"] == "https://zhuanlan.zhihu.com/p/100000002"
    assert completed["mediaOrder"]["backlinkStatus"] == "reviewing"
    assert completed["mediaOrder"]["reviewStatus"] != "public"
    assert completed["mediaOrder"]["imagePublicationEvidence"]["issues"] == ["PUBLIC_IMAGE_MISSING"]
    assert completed["indexSubmission"] is None
    updated_article = client.get(f"/api/articles/{article['id']}").json()
    assert updated_article["status"] != "published"
    assert updated_article.get("publishedUrl", "") == ""


def test_publish_event_rejects_image_evidence_for_the_wrong_article_asset():
    _, device, queued = queue_illustrated_media_publish("Illustrated mismatched publication")
    evidence = illustrated_image_evidence()
    for stage in ["upload", "draft", "public"]:
        evidence[stage]["images"][0]["assetId"] = "asset-from-another-article"

    completed = client.post(f"/api/desktop-commands/{queued['desktopCommand']['id']}/events", json={
        "deviceId": device["device"]["id"],
        "deviceToken": device["deviceToken"],
        "type": "publish_succeeded",
        "payload": {
            "publishedUrl": "https://zhuanlan.zhihu.com/p/illustrated-mismatched",
            "platformStatus": "published",
            "imagePublicationEvidence": evidence,
        },
    }).json()

    assert completed["mediaOrder"]["status"] == "review_required"
    assert completed["indexSubmission"] is None


def test_sohu_publish_from_context_closes_media_publication_loop():
    article = client.post("/api/articles", json={
        "title": "Sohu Full Loop Publish",
        "keyword": "SEO",
        "summary": "Sohu summary",
        "contentMarkdown": "Sohu full loop body",
        "status": "ready",
    }).json()
    device = client.post("/api/desktop-devices/register", json={
        "deviceName": "Windows Workstation",
        "platform": "windows",
        "appVersion": "0.1.0",
        "publicKey": "desktop-public-key",
    }).json()
    created = client.post("/api/media-auth-sessions", json={
        "platform": "sohu",
        "deviceId": device["device"]["id"],
    }).json()
    session = created["session"]
    client.post(
        f"/api/desktop-devices/{device['device']['id']}/media-auth-sessions/{session['id']}/claim",
        json={"pairingCode": session["pairingCode"], "deviceToken": device["deviceToken"]},
    )
    client.post(f"/api/media-auth-sessions/{session['id']}/artifacts", json={
        "deviceId": device["device"]["id"],
        "accountName": "Sohu Account",
        "artifact": {
            "cookies": "encrypted-cookie-payload",
            "localStorage": "encrypted-local-storage",
            "sessionStorage": "encrypted-session-storage",
            "fingerprint": "sha256-sohu-fingerprint",
            "authorizationEvidence": {
                "strongCookiePresent": True,
                "workspaceReady": True,
                "currentUrl": "https://mp.sohu.com/mpfe/v4/main#/contentManagement/news/articlelist",
                "pageTitle": "Sohu creator center",
            },
        },
    })
    account = client.post(f"/api/media-auth-sessions/{session['id']}/bind", json={"name": "Sohu Account"}).json()["mediaAccount"]

    result = client.post(f"/api/articles/{article['id']}/publish-from-context", json={
        "targetId": f"media:{account['id']}",
        "provider": "Google",
        "checkImmediately": True,
        "confirmPublish": True,
        "publishMode": "publish",
        "category": "经验教程",
        "creationStatement": "AI辅助创作",
    }).json()

    assert result["queued"] is True
    assert result["channel"] == "free-media"
    assert result["desktopCommand"]["type"] == "publish_article"
    assert result["desktopCommand"]["payload"]["platform"] == "sohu"
    assert result["desktopCommand"]["payload"]["confirmPublish"] is True
    assert result["desktopCommand"]["payload"]["publishMode"] == "publish"
    assert result["desktopCommand"]["payload"]["provider"] == "Google"
    assert result["desktopCommand"]["payload"]["checkImmediately"] is True
    assert result["desktopCommand"]["payload"]["operationTimeoutMs"] == 600000
    assert result["desktopCommand"]["payload"]["category"] == "经验教程"
    assert result["desktopCommand"]["payload"]["creationStatement"] == "AI辅助创作"

    completed = client.post(f"/api/desktop-commands/{result['desktopCommand']['id']}/events", json={
        "deviceId": device["device"]["id"],
        "deviceToken": device["deviceToken"],
        "type": "publish_succeeded",
        "payload": {
            "publishedUrl": "https://www.sohu.com/a/900000001_122929277",
            "platformStatus": "published",
            "title": "Sohu Full Loop Publish",
        },
    }).json()

    assert completed["command"]["status"] == "succeeded"
    assert completed["command"]["result"]["mediaOrderId"] == completed["mediaOrder"]["id"]
    assert completed["mediaOrder"]["status"] == "succeeded"
    assert completed["mediaOrder"]["backlinkUrl"] == "https://www.sohu.com/a/900000001_122929277"
    assert completed["indexSubmission"] is None
    updated_article = client.get(f"/api/articles/{article['id']}").json()
    assert updated_article["status"] == "published"
    assert updated_article["publishStatus"] == "published"
    assert updated_article["publicationStatus"] == "succeeded"
    assert updated_article["mediaPublishStatus"] == "succeeded"
    assert updated_article["mediaOrderId"] == completed["mediaOrder"]["id"]
    assert updated_article["mediaAccountId"] == account["id"]
    assert updated_article["mediaPlatform"] == "sohu"
    assert updated_article["mediaPublishedUrl"] == "https://www.sohu.com/a/900000001_122929277"
    center_record = next(item for item in client.get("/api/published-center").json()["records"] if item["sourceId"] == completed["mediaOrder"]["id"])
    assert center_record["sourceType"] == "media"
    assert center_record["indexStatus"] == "not_submitted"
    assert center_record["inclusionStatus"] == "unchecked"


def test_csdn_publish_from_context_closes_media_publication_loop():
    article = client.post("/api/articles", json={
        "title": "CSDN Full Loop Publish",
        "keyword": "SEO",
        "keywords": ["AISEO", "自动发布"],
        "summary": "CSDN summary",
        "contentMarkdown": "CSDN full loop body with enough content for publishing.",
        "status": "ready",
    }).json()
    article = client.patch(f"/api/articles/{article['id']}", json={
        "coverImage": {
            "assetId": "asset-cover",
            "purpose": "cover",
            "url": "/uploads/assets/cover.png",
            "path": "C:/uploads/assets/cover.png",
            "altText": "CSDN 封面",
        },
        "inlineImages": [
            {"assetId": "asset-2", "purpose": "inline", "sectionId": "second", "url": "/uploads/assets/second.png", "path": "C:/uploads/assets/second.png", "altText": "第二节插图"},
            {"assetId": "asset-1", "purpose": "inline", "sectionId": "first", "url": "/uploads/assets/first.png", "path": "C:/uploads/assets/first.png", "altText": "第一节插图"},
        ],
        "sections": [
            {"id": "first", "title": "第一节", "content": "正文"},
            {"id": "second", "title": "第二节", "content": "正文"},
        ],
    }).json()
    device = client.post("/api/desktop-devices/register", json={
        "deviceName": "Windows Workstation",
        "platform": "windows",
        "appVersion": "0.1.0",
        "publicKey": "desktop-public-key",
    }).json()
    created = client.post("/api/media-auth-sessions", json={
        "platform": "csdn",
        "deviceId": device["device"]["id"],
    }).json()
    session = created["session"]
    client.post(
        f"/api/desktop-devices/{device['device']['id']}/media-auth-sessions/{session['id']}/claim",
        json={"pairingCode": session["pairingCode"], "deviceToken": device["deviceToken"]},
    )
    client.post(f"/api/media-auth-sessions/{session['id']}/artifacts", json={
        "deviceId": device["device"]["id"],
        "accountName": "CSDN Account",
        "artifact": {
            "cookies": "encrypted-cookie-payload",
            "localStorage": "encrypted-local-storage",
            "sessionStorage": "encrypted-session-storage",
            "fingerprint": "sha256-csdn-fingerprint",
            "authorizationEvidence": {
                "strongCookiePresent": True,
                "workspaceReady": True,
                "currentUrl": "https://mp.csdn.net/mp_blog/creation/editor",
                "pageTitle": "写文章-CSDN创作中心",
            },
        },
    })
    account = client.post(f"/api/media-auth-sessions/{session['id']}/bind", json={"name": "CSDN Account"}).json()["mediaAccount"]

    result = client.post(f"/api/articles/{article['id']}/publish-from-context", json={
        "targetId": f"media:{account['id']}",
        "provider": "Google",
        "checkImmediately": True,
        "confirmPublish": True,
        "publishMode": "publish",
        "platformRules": {
            "category": "AI工具",
            "articleType": "original",
            "visibility": "public",
            "creationStatement": "none",
            "backupToGitCode": False,
            "coverImagePath": "C:/covers/csdn-cover.png",
        },
    }).json()

    assert result["queued"] is True
    assert result["channel"] == "free-media"
    assert result["desktopCommand"]["type"] == "publish_article"
    assert result["desktopCommand"]["payload"]["platform"] == "csdn"
    assert result["desktopCommand"]["payload"]["confirmPublish"] is True
    assert result["desktopCommand"]["payload"]["publishMode"] == "publish"
    assert result["desktopCommand"]["payload"]["keywords"] == ["AISEO", "自动发布"]
    assert result["desktopCommand"]["payload"]["tags"] == ["AISEO", "自动发布"]
    assert result["desktopCommand"]["payload"]["category"] == "AI工具"
    assert result["desktopCommand"]["payload"]["articleType"] == "original"
    assert result["desktopCommand"]["payload"]["visibility"] == "public"
    assert result["desktopCommand"]["payload"]["creationStatement"] == "none"
    assert result["desktopCommand"]["payload"]["backupToGitCode"] is False
    assert result["desktopCommand"]["payload"]["coverImagePath"] == "C:/covers/csdn-cover.png"
    assert result["desktopCommand"]["payload"]["coverImageUrl"] == "/uploads/assets/cover.png"
    assert [image["sectionId"] for image in result["desktopCommand"]["payload"]["inlineImages"]] == ["first", "second"]
    assert [block["type"] for block in result["desktopCommand"]["payload"]["contentBlocks"]] == ["title", "section", "image", "section", "image"]
    assert result["desktopCommand"]["payload"]["contentBlocks"][2]["sectionId"] == "first"
    assert result["desktopCommand"]["payload"]["contentBlocks"][4]["sectionId"] == "second"
    assert "data" not in result["desktopCommand"]["payload"]["inlineImages"][0]

    completed = client.post(f"/api/desktop-commands/{result['desktopCommand']['id']}/events", json={
        "deviceId": device["device"]["id"],
        "deviceToken": device["deviceToken"],
        "type": "publish_succeeded",
        "payload": {
            "publishedUrl": "https://blog.csdn.net/zhixin_ai/article/details/143000000",
            "platformStatus": "published",
            "title": "CSDN Full Loop Publish",
            "imagePublicationEvidence": {
                "version": 1,
                "status": "verified",
                "expectedCount": 2,
                "upload": {
                    "status": "verified",
                    "verifiedCount": 2,
                    "images": [
                        {"assetId": "asset-1", "sectionId": "first", "position": 2, "platformImageUrl": "https://img-blog.csdnimg.cn/first.png", "loaded": True},
                        {"assetId": "asset-2", "sectionId": "second", "position": 4, "platformImageUrl": "https://img-blog.csdnimg.cn/second.png", "loaded": True},
                    ],
                },
                "draft": {
                    "status": "verified",
                    "verifiedCount": 2,
                    "images": [
                        {"assetId": "asset-1", "sectionId": "first", "position": 2, "platformImageUrl": "https://img-blog.csdnimg.cn/first.png", "loaded": True},
                        {"assetId": "asset-2", "sectionId": "second", "position": 4, "platformImageUrl": "https://img-blog.csdnimg.cn/second.png", "loaded": True},
                    ],
                },
                "public": {
                    "status": "verified",
                    "verifiedCount": 2,
                    "images": [
                        {"assetId": "asset-1", "sectionId": "first", "position": 2, "platformImageUrl": "https://img-blog.csdnimg.cn/first.png", "loaded": True},
                        {"assetId": "asset-2", "sectionId": "second", "position": 4, "platformImageUrl": "https://img-blog.csdnimg.cn/second.png", "loaded": True},
                    ],
                },
                "issues": [],
            },
        },
    }).json()

    assert completed["command"]["status"] == "succeeded"
    assert completed["command"]["result"]["mediaOrderId"] == completed["mediaOrder"]["id"]
    assert completed["mediaOrder"]["status"] == "succeeded"
    assert completed["mediaOrder"]["backlinkUrl"] == "https://blog.csdn.net/zhixin_ai/article/details/143000000"
    assert completed["indexSubmission"] is None
    assert "indexSubmissionId" not in completed["command"]["result"]
    center_record = next(item for item in client.get("/api/published-center").json()["records"] if item["sourceId"] == completed["mediaOrder"]["id"])
    assert center_record["sourceType"] == "media"
    assert center_record["indexStatus"] == "not_submitted"
    assert center_record["inclusionStatus"] == "unchecked"


def test_csdn_submitted_but_not_public_creates_review_order_without_index_submission():
    article = client.post("/api/articles", json={
        "title": "CSDN Review Queue Publish",
        "keyword": "SEO",
        "contentMarkdown": "CSDN review queue body with enough content for publishing.",
        "status": "ready",
    }).json()
    device = client.post("/api/desktop-devices/register", json={
        "deviceName": "Windows Workstation",
        "platform": "windows",
        "appVersion": "0.1.0",
        "publicKey": "desktop-public-key",
    }).json()
    created = client.post("/api/media-auth-sessions", json={
        "platform": "csdn",
        "deviceId": device["device"]["id"],
    }).json()
    session = created["session"]
    client.post(
        f"/api/desktop-devices/{device['device']['id']}/media-auth-sessions/{session['id']}/claim",
        json={"pairingCode": session["pairingCode"], "deviceToken": device["deviceToken"]},
    )
    client.post(f"/api/media-auth-sessions/{session['id']}/artifacts", json={
        "deviceId": device["device"]["id"],
        "accountName": "CSDN Account",
        "artifact": {
            "cookies": "encrypted-cookie-payload",
            "localStorage": "encrypted-local-storage",
            "sessionStorage": "encrypted-session-storage",
            "fingerprint": "sha256-csdn-review-fingerprint",
            "authorizationEvidence": {
                "strongCookiePresent": True,
                "workspaceReady": True,
                "currentUrl": "https://mp.csdn.net/mp_blog/creation/editor",
                "pageTitle": "写文章-CSDN创作中心",
            },
        },
    })
    account = client.post(f"/api/media-auth-sessions/{session['id']}/bind", json={"name": "CSDN Account"}).json()["mediaAccount"]

    result = client.post(f"/api/articles/{article['id']}/publish-from-context", json={
        "targetId": f"media:{account['id']}",
        "provider": "Google",
        "checkImmediately": True,
        "confirmPublish": True,
        "publishMode": "publish",
    }).json()

    completed = client.post(f"/api/desktop-commands/{result['desktopCommand']['id']}/events", json={
        "deviceId": device["device"]["id"],
        "deviceToken": device["deviceToken"],
        "type": "publish_succeeded",
        "payload": {
            "publishedUrl": "https://blog.csdn.net/zhixin_ai/article/details/143000404",
            "platformStatus": "submitted_for_review",
            "publiclyVisible": False,
            "reviewStatus": "pending_public_visibility",
            "title": "CSDN Review Queue Publish",
            "message": "CSDN 已提交，但公开页暂时不可访问，等待平台审核或公开延迟。",
        },
    }).json()

    assert completed["command"]["status"] == "succeeded"
    assert completed["indexSubmission"] is None
    assert completed["mediaOrder"]["status"] == "review_required"
    assert completed["mediaOrder"]["backlinkStatus"] == "reviewing"
    assert completed["mediaOrder"]["backlinkUrl"] == ""
    assert completed["mediaOrder"]["reviewUrl"] == "https://blog.csdn.net/zhixin_ai/article/details/143000404"
    assert completed["command"]["result"]["mediaOrderId"] == completed["mediaOrder"]["id"]
    assert "indexSubmissionId" not in completed["command"]["result"]
    updated_article = client.get(f"/api/articles/{article['id']}").json()
    assert updated_article["status"] == "ready"
    assert updated_article["publishStatus"] == "submitted_for_review"
    assert updated_article["indexStatus"] == "not_submitted"

def test_netease_distribution_restricted_publication_is_locked_without_a_backlink():
    device, session, account = create_active_netease_account_for_publication_discovery()
    article = client.post("/api/articles", json={
        "title": "\u6b63\u786e\u770b\u5f85\u552f\u7269\u4e3b\u4e49\u7684\u5b9e\u7528\u6307\u5357",
        "contentMarkdown": "NetEase accepted this article but restricted public distribution.",
        "status": "ready",
    }).json()
    order = client.post("/api/media-orders", json={
        "articleId": article["id"],
        "articleTitle": article["title"],
        "accountId": account["id"],
        "platform": "netease",
        "status": "review_required",
        "platformStatus": "submitted_for_review",
        "reviewStatus": "pending_public_visibility",
    }).json()
    command = client.post("/api/desktop-commands", json={
        "deviceId": device["device"]["id"],
        "type": "discover_publication",
        "mediaAccountId": account["id"],
        "payload": {
            "mediaOrderId": order["id"],
            "articleId": article["id"],
            "articleTitle": article["title"],
            "platform": "netease",
            "sessionId": session["id"],
        },
    }).json()

    completed = client.post(f"/api/desktop-commands/{command['id']}/events", json={
        "deviceId": device["device"]["id"],
        "deviceToken": device["deviceToken"],
        "type": "publication_discovery_succeeded",
        "payload": {
            "found": False,
            "submissionAccepted": True,
            "publicUrl": "",
            "publishedUrl": "",
            "platformStatus": "published_restricted",
            "publiclyVisible": False,
            "reviewStatus": "distribution_restricted",
            "managementRecordFound": True,
            "managementEvidence": {
                "title": article["title"],
                "articleId": "L2ME165V0556O5HU",
                "status": 3,
                "contentState": 3,
                "restrictionReason": "\u5185\u5bb9\u5206\u53d1\u53d7\u9650",
                "appealStatus": 0,
                "publicUrl": "https://www.163.com/dy/article/L2ME165V0556O5HU.html",
            },
            "managementVerificationReason": "PUBLICATION_DISTRIBUTION_RESTRICTED",
        },
    }).json()

    assert completed["mediaOrder"]["status"] == "succeeded"
    assert completed["mediaOrder"]["platformStatus"] == "published_restricted"
    assert completed["mediaOrder"]["reviewStatus"] == "distribution_restricted"
    assert completed["mediaOrder"]["backlinkStatus"] == "blocked"
    assert completed["mediaOrder"]["backlinkUrl"] == ""
    assert completed["mediaOrder"]["reviewUrl"] == ""
    assert completed["mediaOrder"]["publicDiscoveryStatus"] == "restricted"
    assert completed["mediaOrder"]["errorMessage"] == (
        "\u7f51\u6613\u53f7\u5df2\u53d1\u5e03\uff0c\u4f46\u5e73\u53f0\u9650\u5236\u5185\u5bb9\u5206\u53d1\uff0c"
        "\u6682\u65f6\u6ca1\u6709\u53ef\u9a8c\u8bc1\u516c\u5f00 URL\u3002\u8bf7\u524d\u5f80\u7f51\u6613\u53f7\u5185\u5bb9\u7ba1\u7406\u70b9\u51fb\u7533\u8bc9\u3002"
    )

    updated_article = client.get(f"/api/articles/{article['id']}").json()
    assert updated_article["publishStatus"] == "published_restricted"
    assert updated_article["publicationStatus"] == "published_restricted"
    assert updated_article["mediaPublishStatus"] == "published_restricted"
    assert updated_article["publishedUrl"] == ""
    assert updated_article["mediaPublishedUrl"] == ""
    assert updated_article["mediaBacklinkStatus"] == "blocked"
    assert updated_article["mediaPublicDiscoveryStatus"] == "restricted"

    duplicate = client.post(f"/api/articles/{article['id']}/publish-from-context", json={
        "targetId": f"media:{account['id']}",
        "confirmPublish": True,
    })
    assert duplicate.status_code == 409
    assert duplicate.json()["detail"]["code"] == "ARTICLE_PUBLISH_ALREADY_ACTIVE"
    center_record = next(item for item in client.get("/api/published-center").json()["records"] if item["sourceId"] == completed["mediaOrder"]["id"])
    assert center_record["status"] == "succeeded"
    assert center_record["platformStatus"] == "published_restricted"
    assert center_record["backlinkStatus"] == "blocked"
    assert center_record["publishedUrl"] == ""
    assert center_record["reviewUrl"] == ""
    assert center_record["publicDiscoveryStatus"] == "restricted"
    assert center_record["indexStatus"] == "not_submitted"


def test_penguin_creator_review_url_does_not_close_media_publication_loop():
    article = client.post("/api/articles", json={
        "title": "Penguin Full Loop Publish",
        "keyword": "SEO",
        "keywords": ["AISEO", "Penguin"],
        "summary": "Penguin summary",
        "contentMarkdown": "Penguin full loop body with enough content for publishing.",
        "status": "ready",
    }).json()
    device = client.post("/api/desktop-devices/register", json={
        "deviceName": "Windows Workstation",
        "platform": "windows",
        "appVersion": "0.1.0",
        "publicKey": "desktop-public-key",
    }).json()
    created = client.post("/api/media-auth-sessions", json={
        "platform": "penguin",
        "deviceId": device["device"]["id"],
    }).json()
    session = created["session"]
    client.post(
        f"/api/desktop-devices/{device['device']['id']}/media-auth-sessions/{session['id']}/claim",
        json={"pairingCode": session["pairingCode"], "deviceToken": device["deviceToken"]},
    )
    client.post(f"/api/media-auth-sessions/{session['id']}/artifacts", json={
        "deviceId": device["device"]["id"],
        "accountName": "Penguin Account",
        "artifact": {
            "cookies": "encrypted-cookie-payload",
            "localStorage": "encrypted-local-storage",
            "sessionStorage": "encrypted-session-storage",
            "fingerprint": "sha256-penguin-fingerprint",
            "authorizationEvidence": {
                "strongCookiePresent": True,
                "workspaceReady": True,
                "currentUrl": "https://om.qq.com/article/create",
                "pageTitle": "Penguin creator center",
                "pageText": "creator dashboard content management publish article editor",
            },
        },
    })
    account = client.post(f"/api/media-auth-sessions/{session['id']}/bind", json={"name": "Penguin Account"}).json()["mediaAccount"]

    result = client.post(f"/api/articles/{article['id']}/publish-from-context", json={
        "targetId": f"media:{account['id']}",
        "provider": "Google",
        "checkImmediately": True,
        "confirmPublish": True,
        "publishMode": "publish",
        "platformRules": {
            "category": "technology",
            "articleType": "original",
            "coverMode": "auto",
        },
    }).json()

    assert result["queued"] is True
    assert result["channel"] == "free-media"
    assert result["desktopCommand"]["type"] == "publish_article"
    assert result["desktopCommand"]["payload"]["platform"] == "penguin"
    assert result["desktopCommand"]["payload"]["confirmPublish"] is True
    assert result["desktopCommand"]["payload"]["publishMode"] == "publish"
    assert result["desktopCommand"]["payload"]["category"] == "technology"
    assert result["desktopCommand"]["payload"]["articleType"] == "original"
    assert result["desktopCommand"]["payload"]["coverMode"] == "auto"

    completed = client.post(f"/api/desktop-commands/{result['desktopCommand']['id']}/events", json={
        "deviceId": device["device"]["id"],
        "deviceToken": device["deviceToken"],
        "type": "publish_succeeded",
        "payload": {
            "publishedUrl": "https://om.qq.com/s/article/penguin-article-001",
            "platformStatus": "published",
            "publiclyVisible": True,
            "title": "Penguin Full Loop Publish",
        },
    }).json()

    assert completed["command"]["status"] == "succeeded"
    assert completed["command"]["result"]["mediaOrderId"] == completed["mediaOrder"]["id"]
    assert completed["mediaOrder"]["status"] == "review_required"
    assert completed["mediaOrder"]["backlinkUrl"] == ""
    assert completed["mediaOrder"]["reviewUrl"] == "https://om.qq.com/s/article/penguin-article-001"
    assert completed["mediaOrder"]["publicDiscoveryStatus"] == "pending"
    assert completed["indexSubmission"] is None
    assert "indexSubmissionId" not in completed["command"]["result"]


def test_penguin_public_page_is_not_treated_as_creator_review_url():
    assert publication_discovery_required(
        "penguin",
        "https://om.qq.com/s/article/20260721A08QY2",
        "",
    ) is True
    assert publication_discovery_required(
        "penguin",
        "https://page.om.qq.com/page/Oz1VIJyvyWEACK6tfAE-1GA0",
        "",
    ) is False


def test_jianshu_review_required_publication_is_discovery_eligible():
    assert publication_discovery_required(
        "jianshu",
        "",
        "",
    ) is True
    assert publication_discovery_required(
        "jianshu",
        "https://www.jianshu.com/writer#/notebooks/123/notes/456",
        "pending",
    ) is True


def test_publication_candidate_guardrails_reject_creator_review_and_soft_unavailable_urls():
    rejected = [
        ("sohu", "https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?newsId=1055223497", ""),
        ("netease", "https://mp.163.com/article/edit?docId=L2NS082O0556O5HU", ""),
        ("penguin", "https://om.qq.com/s/article/20260721A08QY2", ""),
        ("penguin", "https://page.om.qq.com/page/OJtTOwFQzYWyzI553OiJVUgQ0", "内容被删除 这篇文章从地球上消失了 404"),
        ("toutiao", "https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=7665015703212130866", ""),
        ("baijiahao", "https://baijiahao.baidu.com/builder/rc/edit?article_id=123", ""),
        ("zhihu", "https://zhuanlan.zhihu.com/write", ""),
        ("jianshu", "https://www.jianshu.com/writer#/notebooks/123/notes/456", ""),
        ("csdn", "https://blog.csdn.net/zhixin_ai/article/details/143000404", "你想找的内容离你而去 内容还在审核中"),
    ]
    accepted = [
        ("sohu", "https://www.sohu.com/a/900000001_122929277", "Sohu public article"),
        ("netease", "https://www.163.com/dy/article/L2NS082O0556O5HU.html", "NetEase public article"),
        ("penguin", "https://page.om.qq.com/page/Oz1VIJyvyWEACK6tfAE-1GA0", "Penguin public article"),
        ("toutiao", "https://www.toutiao.com/article/7665015703212130866/", "Toutiao public article"),
        ("baijiahao", "https://baijiahao.baidu.com/s?id=1870656649915477340", "Baijiahao public article"),
        ("zhihu", "https://zhuanlan.zhihu.com/p/2064504898495034807", "Zhihu public article"),
        ("jianshu", "https://www.jianshu.com/p/3d628c37f59b", "Jianshu public article"),
        ("csdn", "https://blog.csdn.net/zhixin_ai/article/details/143000000", "CSDN public article title and body"),
    ]

    for platform, url, page_text in rejected:
        assert candidate_publication_url_is_publishable(platform, url, page_text) is False
    for platform, url, page_text in accepted:
        assert candidate_publication_url_is_publishable(platform, url, page_text) is True


def test_netease_quota_blocked_publish_from_context_creates_review_order_without_index_submission():
    article = client.post("/api/articles", json={
        "title": "Netease Quota Blocked Publish",
        "keyword": "SEO",
        "keywords": ["AISEO", "网易号"],
        "summary": "Netease summary",
        "contentMarkdown": "Netease publish body with enough content for workflow testing.",
        "status": "ready",
    }).json()
    device = client.post("/api/desktop-devices/register", json={
        "deviceName": "Windows Workstation",
        "platform": "windows",
        "appVersion": "0.1.0",
        "publicKey": "desktop-public-key",
    }).json()
    created = client.post("/api/media-auth-sessions", json={
        "platform": "netease",
        "deviceId": device["device"]["id"],
    }).json()
    session = created["session"]
    client.post(
        f"/api/desktop-devices/{device['device']['id']}/media-auth-sessions/{session['id']}/claim",
        json={"pairingCode": session["pairingCode"], "deviceToken": device["deviceToken"]},
    )
    client.post(f"/api/media-auth-sessions/{session['id']}/artifacts", json={
        "deviceId": device["device"]["id"],
        "accountName": "Netease Account",
        "artifact": {
            "cookies": "encrypted-cookie-payload",
            "localStorage": "encrypted-local-storage",
            "sessionStorage": "encrypted-session-storage",
            "fingerprint": "sha256-netease-fingerprint",
            "authorizationEvidence": {
                "strongCookiePresent": True,
                "workspaceReady": True,
                "currentUrl": "https://mp.163.com/#/article-publish",
                "pageTitle": "网易号创作中心",
                "pageText": "创作中心 内容管理 发布 写文章 草稿",
            },
        },
    })
    account = client.post(f"/api/media-auth-sessions/{session['id']}/bind", json={"name": "Netease Account"}).json()["mediaAccount"]

    result = client.post(f"/api/articles/{article['id']}/publish-from-context", json={
        "targetId": f"media:{account['id']}",
        "provider": "Google",
        "checkImmediately": True,
        "confirmPublish": True,
        "publishMode": "publish",
        "platformRules": {
            "category": "科技",
            "coverMode": "auto",
        },
    }).json()

    assert result["queued"] is True
    assert result["desktopCommand"]["payload"]["platform"] == "netease"
    assert result["desktopCommand"]["payload"]["category"] == "科技"
    assert result["desktopCommand"]["payload"]["coverMode"] == "auto"

    completed = client.post(f"/api/desktop-commands/{result['desktopCommand']['id']}/events", json={
        "deviceId": device["device"]["id"],
        "deviceToken": device["deviceToken"],
        "type": "publish_succeeded",
        "payload": {
            "publishedUrl": "",
            "platformStatus": "account_under_review",
            "publiclyVisible": False,
            "reviewStatus": "account_under_review",
            "message": "网易号账号仍在审核中，暂不能自动发布。",
            "title": "Netease Quota Blocked Publish",
        },
    }).json()

    assert completed["command"]["status"] == "succeeded"
    assert completed["mediaOrder"]["status"] == "review_required"
    assert completed["mediaOrder"]["backlinkStatus"] == "blocked"
    assert completed["mediaOrder"]["platformStatus"] == "account_under_review"
    assert completed["mediaOrder"]["backlinkUrl"] == ""
    assert completed["mediaOrder"]["errorMessage"] == "网易号账号仍在审核中，暂不能自动发布。"
    assert completed["indexSubmission"] is None
    updated_article = client.get(f"/api/articles/{article['id']}").json()
    assert updated_article["publishStatus"] == "account_under_review"
    assert updated_article["indexStatus"] == "not_submitted"


def test_netease_submitted_review_url_creates_recheckable_order_without_index_submission():
    article = client.post("/api/articles", json={
        "title": "Netease Public Review Candidate",
        "keyword": "SEO",
        "summary": "Netease review summary",
        "contentMarkdown": "Netease submitted article body for later public verification.",
        "status": "ready",
    }).json()
    device = client.post("/api/desktop-devices/register", json={
        "deviceName": "Windows Workstation",
        "platform": "windows",
        "appVersion": "0.1.0",
        "publicKey": "desktop-public-key",
    }).json()
    created = client.post("/api/media-auth-sessions", json={
        "platform": "netease",
        "deviceId": device["device"]["id"],
    }).json()
    session = created["session"]
    client.post(
        f"/api/desktop-devices/{device['device']['id']}/media-auth-sessions/{session['id']}/claim",
        json={"pairingCode": session["pairingCode"], "deviceToken": device["deviceToken"]},
    )
    client.post(f"/api/media-auth-sessions/{session['id']}/artifacts", json={
        "deviceId": device["device"]["id"],
        "accountName": "Netease Account",
        "artifact": {
            "cookies": "encrypted-cookie-payload",
            "localStorage": "encrypted-local-storage",
            "sessionStorage": "encrypted-session-storage",
            "fingerprint": "sha256-netease-review-url-fingerprint",
            "authorizationEvidence": {
                "strongCookiePresent": True,
                "workspaceReady": True,
                "currentUrl": "https://mp.163.com/#/article-publish",
                "pageTitle": "Netease creator center",
                "pageText": "content management write article publish",
            },
        },
    })
    account = client.post(f"/api/media-auth-sessions/{session['id']}/bind", json={"name": "Netease Account"}).json()["mediaAccount"]

    result = client.post(f"/api/articles/{article['id']}/publish-from-context", json={
        "targetId": f"media:{account['id']}",
        "provider": "Google",
        "checkImmediately": True,
        "confirmPublish": True,
        "publishMode": "publish",
    }).json()

    candidate_url = "https://www.163.com/dy/article/REVIEW_PENDING.html"
    completed = client.post(f"/api/desktop-commands/{result['desktopCommand']['id']}/events", json={
        "deviceId": device["device"]["id"],
        "deviceToken": device["deviceToken"],
        "type": "publish_succeeded",
        "payload": {
            "publishedUrl": "",
            "reviewUrl": candidate_url,
            "platformStatus": "submitted_for_review",
            "publiclyVisible": False,
            "reviewStatus": "pending_public_visibility",
            "message": "Submitted to NetEase; public page needs later verification.",
        },
    }).json()

    assert completed["command"]["status"] == "succeeded"
    assert completed["indexSubmission"] is None
    assert completed["mediaOrder"]["status"] == "review_required"
    assert completed["mediaOrder"]["backlinkStatus"] == "reviewing"
    assert completed["mediaOrder"]["backlinkUrl"] == ""
    assert completed["mediaOrder"]["reviewUrl"] == candidate_url
    assert completed["mediaOrder"]["reviewStatus"] == "pending_public_visibility"
    assert completed["command"]["result"]["mediaOrderId"] == completed["mediaOrder"]["id"]
    assert "indexSubmissionId" not in completed["command"]["result"]
    updated_article = client.get(f"/api/articles/{article['id']}").json()
    assert updated_article["publishStatus"] == "submitted_for_review"
    assert updated_article["indexStatus"] == "not_submitted"


def test_netease_draft_editor_url_is_not_saved_as_review_or_backlink_url():
    article = client.post("/api/articles", json={
        "title": "Netease private draft URL must stay private",
        "contentMarkdown": "This article verifies that a private NetEase editor URL never becomes a review or backlink URL.",
        "status": "ready",
    }).json()
    device, session, account = create_active_netease_account_for_publication_discovery()
    command = client.post("/api/desktop-commands", json={
        "deviceId": device["device"]["id"],
        "type": "publish_article",
        "mediaAccountId": account["id"],
        "payload": {
            "articleId": article["id"],
            "articleTitle": article["title"],
            "platform": "netease",
            "sessionId": session["id"],
            "confirmPublish": True,
        },
    }).json()

    completed = client.post(f"/api/desktop-commands/{command['id']}/events", json={
        "deviceId": device["device"]["id"],
        "deviceToken": device["deviceToken"],
        "type": "publish_succeeded",
        "payload": {
            "draftUrl": "https://mp.163.com/#/article-publish",
            "publishedUrl": "",
            "reviewUrl": "",
            "platformStatus": "submitted_for_review",
            "publiclyVisible": False,
            "reviewStatus": "pending_public_visibility",
            "message": "NetEase accepted the article and is reviewing it.",
        },
    }).json()

    assert completed["mediaOrder"]["status"] == "review_required"
    assert completed["mediaOrder"]["reviewUrl"] == ""
    assert completed["mediaOrder"]["backlinkUrl"] == ""
    assert completed["mediaOrder"]["publicDiscoveryStatus"] == "pending"
    updated_article = client.get(f"/api/articles/{article['id']}").json()
    assert updated_article["mediaReviewUrl"] == ""
    assert updated_article["mediaPublishedUrl"] == ""

def test_patch_media_account_preserves_chinese_profile_text():
    account = client.post("/api/media-accounts", json={"name": "Zhihu Account", "platform": "zhihu", "status": "active"}).json()

    patched = client.patch(
        f"/api/media-accounts/{account['id']}",
        json={"name": "知乎用户z1Qaed", "accountName": "知乎用户z1Qaed"},
    ).json()

    assert patched["name"] == "知乎用户z1Qaed"
    assert patched["accountName"] == "知乎用户z1Qaed"


def test_publish_from_context_rejects_request_thread_publish():
    article = client.post("/api/articles", json={"title": "Rejected Context Publish", "keyword": "SEO", "status": "ready"}).json()
    site = client.post("/api/sites", json={"name": "Rejected Site", "type": "Webhook", "baseUrl": "https://reject.test"}).json()

    response = client.post(f"/api/articles/{article['id']}/publish-from-context", json={
        "targetId": f"site:{site['id']}",
        "provider": "IndexNow",
        "async": False,
    })

    assert response.status_code == 400
    assert response.json()["detail"] == "PUBLISH_FROM_CONTEXT_REQUIRES_QUEUE"
    assert client.get("/api/publish-jobs").json() == []
    assert client.get("/api/index-submissions").json() == []


def test_knowledge_upload_rejects_request_thread_parsing():
    response = client.post(
        "/api/knowledge-base/upload",
        files={"file": ("seo-notes.txt", b"First SEO paragraph.\n\nSecond GEO paragraph.", "text/plain")},
        data={"title": "SEO Notes", "tags": "seo,geo", "defer": "false"},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "KNOWLEDGE_UPLOAD_REQUIRES_QUEUE"
    assert client.get("/api/knowledge-base").json() == []
    assert client.get("/api/tasks").json() == []


def test_knowledge_upload_defaults_to_worker_queue_without_parsing_in_request():
    item = client.post(
        "/api/knowledge-base/upload",
        files={"file": ("queued-notes.txt", b"Queued SEO paragraph.\n\nQueued GEO paragraph.", "text/plain")},
        data={"title": "Queued Notes", "tags": "seo,geo"},
    ).json()

    assert item["status"] == "queued"
    assert item["source"] == "upload"
    assert item["chunkCount"] == 0
    assert item["vectorCount"] == 0
    task = client.get(f"/api/tasks/{item['taskId']}").json()
    assert task["type"] == "knowledge-upload-parse"
    assert task["queue"] == "knowledge"
    assert task["payload"]["knowledgeId"] == item["id"]
    assert task["payload"]["path"] == item["path"]
    assert client.get(f"/api/knowledge-base/{item['id']}/chunks").json() == []


def test_asset_upload_persists_file_and_asset_record():
    response = client.post(
        "/api/assets/upload",
        files={"file": ("hero.png", b"fake-image-bytes", "image/png")},
        data={"altText": "AI SEO hero", "tags": "hero,seo", "relatedArticle": "article-1"},
    )
    asset = response.json()

    assert asset["filename"] == "hero.png"
    assert asset["source"] == "upload"
    assert asset["type"] == "inline"
    assert asset["contentType"] == "image/png"
    assert asset["sizeBytes"] == len(b"fake-image-bytes")
    assert asset["tags"] == ["hero", "seo"]
    assert asset["path"]
    downloaded = client.get(asset["url"])
    assert downloaded.status_code == 200
    assert downloaded.content == b"fake-image-bytes"
    assert client.get("/api/assets").json()[0]["id"] == asset["id"]
    assert any(audit["action"] == "asset.upload" for audit in client.get("/api/audit-logs").json())


def test_knowledge_url_fetch_defaults_to_worker_queue():
    item = client.post("/api/knowledge-base/fetch-url", json={
        "title": "Remote Guide",
        "url": "https://example.com/guide",
        "refreshMode": "scheduled",
    }).json()

    assert item["status"] == "queued"
    assert item["source"] == "url"
    task = client.get(f"/api/tasks/{item['taskId']}").json()
    assert task["type"] == "knowledge-fetch-url"
    assert task["queue"] == "knowledge"
    assert task["payload"]["knowledgeId"] == item["id"]
    assert client.get(f"/api/knowledge-base/{item['id']}/chunks").json() == []


def test_knowledge_url_fetch_rejects_request_thread_fetch():
    response = client.post("/api/knowledge-base/fetch-url", json={
        "title": "Remote Sync Guide",
        "url": "https://example.com/sync-guide",
        "defer": False,
    })

    assert response.status_code == 400
    assert response.json()["detail"] == "KNOWLEDGE_FETCH_REQUIRES_QUEUE"
    assert client.get("/api/knowledge-base").json() == []
    assert client.get("/api/tasks").json() == []


def test_knowledge_search_returns_ranked_chunks_with_filters():
    first = client.post("/api/knowledge-base", json={
        "id": "knowledge-search-1",
        "title": "Publishing Facts",
        "tags": ["publishing", "seo"],
        "status": "completed",
    }).json()
    second = client.post("/api/knowledge-base", json={
        "id": "knowledge-search-2",
        "title": "Brand Facts",
        "tags": ["brand"],
        "status": "completed",
    }).json()
    client.post("/api/knowledge-chunks", json={
        "id": "chunk-publishing",
        "knowledgeId": first["id"],
        "index": 0,
        "content": "Automatic publishing sends SEO articles to WordPress and media channels.",
    })
    client.post("/api/knowledge-chunks", json={
        "id": "chunk-brand",
        "knowledgeId": second["id"],
        "index": 0,
        "content": "Brand voice guidance for customer success stories.",
    })

    result = client.post("/api/knowledge-base/search", json={
        "query": "SEO publishing WordPress",
        "topK": 2,
        "tags": ["seo"],
    }).json()

    assert result["query"] == "SEO publishing WordPress"
    assert result["total"] == 1
    assert result["records"][0]["chunkId"] == "chunk-publishing"
    assert result["records"][0]["knowledgeId"] == first["id"]
    assert result["records"][0]["knowledgeTitle"] == "Publishing Facts"
    assert result["records"][0]["score"] > 0
    assert "WordPress" in result["records"][0]["content"]


def test_knowledge_search_requires_query():
    response = client.post("/api/knowledge-base/search", json={"query": "   "})

    assert response.status_code == 400
    assert response.json()["detail"] == "QUERY_REQUIRED"


def test_task_retry_logs_audit_and_requeues_payload():
    task = client.post("/api/tasks", json={
        "type": "index-retry",
        "title": "Retry failed index",
        "payload": {"submissionId": "index-1"},
        "queue": "index",
        "status": "failed",
        "errorMessage": "provider timeout",
    }).json()

    retried = client.post(f"/api/tasks/{task['id']}/retry").json()

    assert retried["status"] in ["queued", "pending"]
    assert retried["retryCount"] == 1
    logs = client.get(f"/api/tasks/{task['id']}/logs").json()
    assert any(log["event"] == "task.retry" for log in logs)
    assert any(audit["action"] == "task.retry" for audit in client.get("/api/audit-logs").json())


def test_failure_center_lists_failed_tasks_with_logs_and_retry_action():
    failed = client.post("/api/tasks", json={
        "type": "seo-provider-sync",
        "title": "Sync provider data",
        "payload": {"recordId": "keyword-1"},
        "queue": "seo",
        "status": "failed",
        "errorMessage": "provider timeout",
    }).json()
    client.post("/api/tasks", json={
        "type": "ai-generate-article",
        "title": "Generate article",
        "payload": {"keyword": "AI SEO"},
        "queue": "ai",
        "status": "queued",
    })

    center = client.get("/api/failure-center").json()

    assert center["summary"]["failed"] == 1
    assert center["summary"]["retryable"] == 1
    assert center["records"][0]["id"] == failed["id"]
    assert center["records"][0]["errorMessage"] == "provider timeout"
    assert center["records"][0]["retryable"] is True
    assert any(log["event"] == "task.created" for log in center["records"][0]["logs"])

    detail = client.get(f"/api/failure-center/{failed['id']}").json()
    assert detail["task"]["id"] == failed["id"]
    assert detail["lastError"]["message"] == "provider timeout"
    assert detail["nextActions"][0]["action"] == "retry"

    retried = client.post(f"/api/failure-center/{failed['id']}/retry").json()
    assert retried["task"]["retryCount"] == 1
    assert retried["task"]["status"] in ["queued", "pending"]
    assert retried["notification"]["level"] == "info"
    assert any(audit["action"] == "task.retry" for audit in client.get("/api/audit-logs").json())


def test_failure_detail_includes_linked_llm_requests_for_failed_ai_task():
    task = client.post("/api/tasks", json={
        "type": "ai-generate-article",
        "title": "Generate article with model failure",
        "payload": {"keyword": "AI SEO"},
        "queue": "ai",
        "status": "failed",
        "errorMessage": "DeepSeek timeout",
    }).json()
    llm_request = client.post("/api/llm-requests", json={
        "provider": "deepseek",
        "model": "deepseek-v4-pro",
        "status": "failed",
        "taskId": task["id"],
        "articleId": "",
        "contextSummary": {"keyword": "AI SEO", "ruleId": "rule-1"},
        "requestPayload": {"model": "deepseek-v4-pro", "messages": [{"role": "user", "content": "Write article"}]},
        "responseSummary": {},
        "errorMessage": "DeepSeek timeout",
    }).json()

    detail = client.get(f"/api/failure-center/{task['id']}").json()

    assert detail["task"]["id"] == task["id"]
    assert detail["llmRequests"][0]["id"] == llm_request["id"]
    assert detail["llmRequests"][0]["taskId"] == task["id"]
    assert detail["llmRequests"][0]["status"] == "failed"
    assert any(action["action"] == "view-llm-request" and action["enabled"] for action in detail["nextActions"])


def test_failure_detail_includes_audit_queue_and_provider_evidence():
    task = client.post("/api/tasks", json={
        "type": "serp-collect",
        "title": "Collect SERP with provider pending",
        "payload": {"keyword": "AI SEO"},
        "queue": "seo",
        "status": "pending",
        "errorMessage": "provider not configured",
    }).json()
    provider_result = client.post("/api/seo-provider-results", json={
        "taskId": task["id"],
        "taskType": "serp-collect",
        "recordKind": "serpAnalyses",
        "sourceRecordId": "serp-1",
        "provider": "unconfigured",
        "status": "provider_pending",
        "requestPayload": {"keyword": "AI SEO"},
        "response": {"message": "SEO provider base URL is not configured"},
    }).json()
    client.post("/api/audit-logs", json={
        "action": "task.failed",
        "targetType": "tasks",
        "targetId": task["id"],
        "detail": {"error": "provider not configured"},
        "actor": "worker",
    })

    detail = client.get(f"/api/failure-center/{task['id']}").json()

    assert detail["queueResult"]["queued"] is True
    assert detail["queueResult"]["queue"].endswith(":seo")
    assert any(item["targetId"] == task["id"] for item in detail["auditLogs"])
    assert any(item["action"] == "task.failed" for item in detail["auditLogs"])
    assert detail["providerResults"][0]["id"] == provider_result["id"]
    assert detail["providerResults"][0]["status"] == "provider_pending"
    assert any(action["action"] == "view-provider-result" and action["enabled"] for action in detail["nextActions"])
    assert any(action["action"] == "view-audit" and action["enabled"] for action in detail["nextActions"])


def test_notifications_can_be_marked_read_and_unread_with_navigation_target():
    task = client.post("/api/tasks", json={
        "type": "ai-generate-article",
        "title": "Generate article with notification",
        "payload": {"keyword": "AI SEO"},
        "queue": "ai",
        "status": "failed",
        "errorMessage": "DeepSeek timeout",
    }).json()
    notification = client.post("/api/notifications", json={
        "title": "AI 任务失败",
        "message": "DeepSeek timeout",
        "level": "error",
        "target": {"taskId": task["id"], "kind": "failure-center"},
    }).json()

    listed = client.get("/api/notifications").json()
    assert listed[0]["id"] == notification["id"]
    assert listed[0]["read"] is False
    assert listed[0]["target"]["taskId"] == task["id"]
    assert listed[0]["href"] == "/dashboard"

    marked_read = client.patch(f"/api/notifications/{notification['id']}", json={"read": True}).json()
    assert marked_read["read"] is True
    assert marked_read["readAt"]

    marked_unread = client.patch(f"/api/notifications/{notification['id']}", json={"read": False}).json()
    assert marked_unread["read"] is False
    assert marked_unread["readAt"] == ""


def test_notifications_batch_mark_selected_or_all_as_read():
    first = client.post("/api/notifications", json={"title": "通知 1", "message": "需要处理", "level": "warning"}).json()
    second = client.post("/api/notifications", json={"title": "通知 2", "message": "已经同步", "level": "info"}).json()

    selected = client.post("/api/notifications/batch", json={"ids": [first["id"]], "read": True}).json()
    assert selected["updated"] == 1
    records = {item["id"]: item for item in client.get("/api/notifications").json()}
    assert records[first["id"]]["read"] is True
    assert records[second["id"]]["read"] is False

    all_read = client.post("/api/notifications/batch", json={"scope": "all", "read": True}).json()
    assert all_read["updated"] == 2
    assert all(item["read"] is True for item in client.get("/api/notifications").json())


def test_seo_provider_config_can_be_saved_and_health_checked_without_exposing_secret():
    config = client.post("/api/seo-provider-configs", json={
        "name": "Search Provider",
        "provider": "custom-crawler",
        "baseUrl": "https://seo-provider.test",
        "apiKey": "placeholder-provider-key",
        "capabilities": ["keyword-discover", "serp-collect", "geo-collect", "ranking-check"],
        "enabled": True,
    }).json()

    assert config["id"].startswith("seo-provider-config-")
    assert config["baseUrl"] == "https://seo-provider.test"
    assert config["apiKeyMasked"] == "pla********************y"
    assert "apiKey" not in config

    health = client.post(f"/api/seo-provider-configs/{config['id']}/health-check").json()

    assert health["config"]["status"] == "connected"
    assert health["config"]["lastHealthCheck"]["ok"] is True
    assert health["result"]["status"] == "connected"
    assert health["result"]["provider"] == "custom-crawler"
    assert health["result"]["requestPayload"]["capabilities"] == ["keyword-discover", "serp-collect", "geo-collect", "ranking-check"]
    assert "placeholder-provider-key" not in str(health)
    assert any(item["action"] == "seo_provider.health_check" for item in client.get("/api/audit-logs").json())
    notifications = client.get("/api/notifications").json()
    assert notifications[0]["target"]["seoProviderConfigId"] == config["id"]
    assert notifications[0]["level"] == "success"


def test_unconfigured_seo_provider_health_check_creates_actionable_warning():
    config = client.post("/api/seo-provider-configs", json={
        "name": "Missing Provider",
        "provider": "custom-crawler",
        "baseUrl": "",
        "enabled": True,
    }).json()

    health = client.post(f"/api/seo-provider-configs/{config['id']}/health-check").json()

    assert health["config"]["status"] == "provider_pending"
    assert health["config"]["lastHealthCheck"]["ok"] is False
    assert health["result"]["status"] == "provider_pending"
    assert any(item["level"] == "warning" and item["target"]["seoProviderConfigId"] == config["id"] for item in client.get("/api/notifications").json())


def test_seo_collection_endpoints_create_queued_real_source_tasks():
    keyword = client.post("/api/keywords/discover", json={"seed": "AI SEO", "provider": "search-provider"}).json()
    serp = client.post("/api/serp-analysis/collect", json={"keyword": "AI SEO", "provider": "serp-provider"}).json()
    geo = client.post("/api/geo-analysis/collect", json={"brand": "Zhixin AI", "platforms": ["ChatGPT"]}).json()
    rank = client.post("/api/ranking-tracker/check", json={"keyword": "AI SEO", "url": "https://example.com"}).json()

    assert keyword["task"]["queue"] == "seo"
    assert serp["task"]["type"] == "serp-collect"
    assert geo["task"]["type"] == "geo-collect"
    assert rank["task"]["type"] == "ranking-check"
    assert len(client.get("/api/tasks").json()) == 4


def test_seo_collection_rejects_request_thread_collection():
    response = client.post("/api/serp-analysis/collect", json={
        "keyword": "AI SEO",
        "provider": "serp-provider",
        "async": False,
    })

    assert response.status_code == 400
    assert response.json()["detail"] == "SEO_COLLECTION_REQUIRES_QUEUE"
    assert client.get("/api/serp-analysis").json() == []
    assert client.get("/api/tasks").json() == []


def test_seo_collection_endpoint_binds_provider_config_to_record_and_task():
    config = client.post("/api/seo-provider-configs", json={
        "name": "Bound Provider",
        "provider": "bound-seo",
        "baseUrl": "https://seo-provider.test",
        "apiKey": "placeholder-provider-key",
        "capabilities": ["keyword-discover"],
        "enabled": True,
    }).json()

    result = client.post("/api/keywords/discover", json={
        "seed": "AI SEO",
        "providerConfigId": config["id"],
    }).json()

    assert result["record"]["providerConfigId"] == config["id"]
    assert result["record"]["provider"] == "bound-seo"
    assert result["task"]["payload"]["providerConfigId"] == config["id"]
    assert result["task"]["payload"]["provider"] == "bound-seo"


def test_seo_collection_rejects_unknown_provider_config_id():
    response = client.post("/api/keywords/discover", json={
        "seed": "AI SEO",
        "providerConfigId": "seo-provider-config-missing",
    })

    assert response.status_code == 404
    assert response.json()["detail"] == "SEOPROVIDERCONFIGS_NOT_FOUND"


def test_seo_collection_placeholders_are_business_record_shaped():
    keyword = client.post("/api/keywords/discover", json={"seed": "AI SEO", "provider": "search-provider"}).json()["record"]
    serp = client.post("/api/serp-analysis/collect", json={"keyword": "AI SEO", "searchEngine": "Google", "region": "US", "device": "mobile"}).json()["record"]
    geo = client.post("/api/geo-analysis/collect", json={"keyword": "AI SEO", "brand": "Zhixin AI", "platform": "DeepSeek"}).json()["record"]
    rank = client.post("/api/ranking-tracker/check", json={"keyword": "AI SEO", "url": "https://example.com", "engine": "Google"}).json()["record"]

    assert keyword["word"] == "AI SEO"
    assert keyword["status"] == "queued"
    assert keyword["trend"] == "stable"
    assert keyword["relatedWords"] == []

    assert serp["keyword"] == "AI SEO"
    assert serp["status"] == "queued"
    assert serp["topResults"] == []
    assert serp["relatedQuestions"] == []
    assert serp["relatedKeywords"] == []
    assert serp["contentBrief"]

    assert geo["keyword"] == "AI SEO"
    assert geo["status"] == "queued"
    assert geo["platform"] == "DeepSeek"
    assert geo["question"]
    assert geo["brandMention"] is False

    assert rank["keyword"] == "AI SEO"
    assert rank["url"] == "https://example.com"
    assert rank["status"] == "queued"
    assert rank["position"] == 0
    assert rank["change"] == 0


def test_async_media_order_publish_and_index_queues_without_immediate_backlink():
    order = client.post("/api/media-orders", json={"articleTitle": "Async media article", "resourceName": "Media"}).json()

    result = client.post("/api/media-orders/publish-and-index", json={
        "orderId": order["id"],
        "provider": "Google",
        "async": True,
    }).json()

    assert result["queued"] is True
    assert result["task"]["type"] == "media-backlink-index"
    assert result["task"]["queue"] == "media"
    updated = client.get("/api/media-orders").json()[0]
    assert updated["status"] == "pending"
    assert updated["backlinkUrl"] == ""


def test_media_order_publication_recheck_queues_worker_task():
    order = client.post("/api/media-orders", json={
        "articleTitle": "NetEase review article",
        "resourceName": "网易号",
        "status": "review_required",
        "platformStatus": "submitted_for_review",
        "reviewUrl": "https://www.163.com/dy/article/REVIEW.html",
    }).json()

    result = client.post("/api/media-orders/recheck-publication", json={
        "orderId": order["id"],
        "provider": "Google",
        "checkImmediately": True,
    }).json()

    assert result["queued"] is True
    assert result["task"]["type"] == "media-publication-recheck"
    assert result["task"]["queue"] == "media"
    assert result["task"]["payload"]["orderId"] == order["id"]
    assert result["task"]["payload"]["submitIndex"] is False


def create_active_netease_account_for_publication_discovery():
    device = client.post("/api/desktop-devices/register", json={
        "deviceName": "NetEase Discovery Desktop",
        "platform": "windows",
        "appVersion": "0.1.0",
        "publicKey": "desktop-public-key",
    }).json()
    session = client.post("/api/media-auth-sessions", json={
        "platform": "netease",
        "deviceId": device["device"]["id"],
        "queueDesktopCommand": False,
    }).json()["session"]
    client.post(
        f"/api/desktop-devices/{device['device']['id']}/media-auth-sessions/{session['id']}/claim",
        json={"pairingCode": session["pairingCode"], "deviceToken": device["deviceToken"]},
    )
    client.post(f"/api/media-auth-sessions/{session['id']}/artifacts", json={
        "deviceId": device["device"]["id"],
        "accountName": "网易号公开复验账号",
        "artifact": {
            "cookies": "encrypted-cookie-payload",
            "localStorage": "encrypted-local-storage",
            "sessionStorage": "encrypted-session-storage",
            "fingerprint": "sha256-netease-publication-discovery",
            "authorizationEvidence": {
                "strongCookiePresent": True,
                "workspaceReady": True,
                "currentUrl": "https://mp.163.com/#/article/manage",
                "pageTitle": "网易号内容管理",
                "pageText": "创作中心 内容管理 发布 写文章",
            },
        },
    })
    account = client.post(
        f"/api/media-auth-sessions/{session['id']}/bind",
        json={"name": "网易号公开复验账号"},
    ).json()["mediaAccount"]
    return device, session, account


def create_active_sohu_account_for_publication_discovery():
    device = client.post("/api/desktop-devices/register", json={
        "deviceName": "Sohu Discovery Desktop",
        "platform": "windows",
        "appVersion": "0.1.0",
        "publicKey": "desktop-public-key",
    }).json()
    session = client.post("/api/media-auth-sessions", json={
        "platform": "sohu",
        "deviceId": device["device"]["id"],
        "queueDesktopCommand": False,
    }).json()["session"]
    client.post(
        f"/api/desktop-devices/{device['device']['id']}/media-auth-sessions/{session['id']}/claim",
        json={"pairingCode": session["pairingCode"], "deviceToken": device["deviceToken"]},
    )
    client.post(f"/api/media-auth-sessions/{session['id']}/artifacts", json={
        "deviceId": device["device"]["id"],
        "accountName": "Sohu Discovery Account",
        "artifact": {
            "cookies": "encrypted-cookie-payload",
            "localStorage": "encrypted-local-storage",
            "sessionStorage": "encrypted-session-storage",
            "fingerprint": "sha256-sohu-publication-discovery",
            "authorizationEvidence": {
                "strongCookiePresent": True,
                "workspaceReady": True,
                "currentUrl": "https://mp.sohu.com/mpfe/v4/contentManagement/news/articlelist",
                "pageTitle": "Sohu creator center",
                "pageText": "content management publish article",
            },
        },
    })
    account = client.post(
        f"/api/media-auth-sessions/{session['id']}/bind",
        json={"name": "Sohu Discovery Account"},
    ).json()["mediaAccount"]
    return device, session, account


def create_active_zhihu_account_for_image_recheck():
    device = client.post("/api/desktop-devices/register", json={
        "deviceName": "Zhihu Image Recheck Desktop",
        "platform": "windows",
        "appVersion": "0.1.0",
        "publicKey": "desktop-public-key",
    }).json()
    session = client.post("/api/media-auth-sessions", json={
        "platform": "zhihu",
        "deviceId": device["device"]["id"],
        "queueDesktopCommand": False,
    }).json()["session"]
    client.post(
        f"/api/desktop-devices/{device['device']['id']}/media-auth-sessions/{session['id']}/claim",
        json={"pairingCode": session["pairingCode"], "deviceToken": device["deviceToken"]},
    )
    client.post(f"/api/media-auth-sessions/{session['id']}/artifacts", json={
        "deviceId": device["device"]["id"],
        "accountName": "Zhihu image account",
        "artifact": {
            "cookies": "encrypted-cookie-payload",
            "localStorage": "encrypted-local-storage",
            "sessionStorage": "encrypted-session-storage",
            "fingerprint": "sha256-zhihu-image-recheck",
            "authorizationEvidence": {
                "strongCookiePresent": True,
                "workspaceReady": True,
                "currentUrl": "https://www.zhihu.com/creator",
                "pageTitle": "Zhihu creator center",
            },
        },
    })
    account = client.post(
        f"/api/media-auth-sessions/{session['id']}/bind",
        json={"name": "Zhihu image account"},
    ).json()["mediaAccount"]
    return device, session, account


def create_active_baijiahao_account_for_image_recheck():
    device = client.post("/api/desktop-devices/register", json={
        "deviceName": "Baijiahao Image Recheck Desktop",
        "platform": "windows",
        "appVersion": "0.1.0",
        "publicKey": "desktop-public-key",
    }).json()
    session = client.post("/api/media-auth-sessions", json={
        "platform": "baijiahao",
        "deviceId": device["device"]["id"],
        "queueDesktopCommand": False,
    }).json()["session"]
    client.post(
        f"/api/desktop-devices/{device['device']['id']}/media-auth-sessions/{session['id']}/claim",
        json={"pairingCode": session["pairingCode"], "deviceToken": device["deviceToken"]},
    )
    client.post(f"/api/media-auth-sessions/{session['id']}/artifacts", json={
        "deviceId": device["device"]["id"],
        "accountName": "Baijiahao image account",
        "artifact": {
            "cookies": "encrypted-cookie-payload",
            "localStorage": "encrypted-local-storage",
            "sessionStorage": "encrypted-session-storage",
            "fingerprint": "sha256-baijiahao-image-recheck",
            "authorizationEvidence": {
                "strongCookiePresent": True,
                "workspaceReady": True,
                "currentUrl": "https://baijiahao.baidu.com/builder/rc/home",
                "pageTitle": "Baijiahao creator center",
            },
        },
    })
    account = client.post(
        f"/api/media-auth-sessions/{session['id']}/bind",
        json={"name": "Baijiahao image account"},
    ).json()["mediaAccount"]
    return device, session, account


def verified_image_publication_evidence():
    expected = [
        {"assetId": "asset-a", "sectionId": "section-a", "position": 1, "idempotencyKey": "key-a"},
        {"assetId": "asset-b", "sectionId": "section-b", "position": 3, "idempotencyKey": "key-b"},
    ]
    images = [
        {**expected[0], "platformImageUrl": "https://picx.zhimg.com/a.png", "loaded": True},
        {**expected[1], "platformImageUrl": "https://picx.zhimg.com/b.png", "loaded": True},
    ]
    stage = {"expectedCount": 2, "observedCount": 2, "verifiedCount": 2, "status": "verified", "images": images}
    return {
        "version": 1,
        "status": "verified",
        "expectedCount": 2,
        "expected": expected,
        "upload": {**stage, "stage": "upload"},
        "draft": {**stage, "stage": "draft"},
        "public": {**stage, "stage": "public"},
        "issues": [],
        "verifiedAt": "2026-07-14T00:00:00Z",
    }


def test_zhihu_image_order_recheck_queues_desktop_publication_discovery():
    device, session, account = create_active_zhihu_account_for_image_recheck()
    article = client.post("/api/articles", json={
        "title": "Zhihu illustrated article",
        "contentMarkdown": "Illustrated article body for public verification.",
        "status": "ready",
    }).json()
    evidence = verified_image_publication_evidence()
    evidence["status"] = "review_required"
    evidence["public"] = {**evidence["public"], "status": "failed", "verifiedCount": 0, "images": []}
    evidence["issues"] = ["PUBLIC_IMAGE_MISSING"]
    order = client.post("/api/media-orders", json={
        "articleId": article["id"],
        "articleTitle": article["title"],
        "accountId": account["id"],
        "platform": "zhihu",
        "status": "review_required",
        "reviewStatus": "pending_public_visibility",
        "reviewUrl": "https://zhuanlan.zhihu.com/p/123456789",
        "imagePublicationEvidence": evidence,
    }).json()

    result = client.post("/api/media-orders/recheck-publication", json={
        "orderId": order["id"],
        "provider": "Google",
        "checkImmediately": True,
    }).json()

    assert result["queued"] is True
    assert result["task"] is None
    assert result["desktopCommand"]["type"] == "discover_publication"
    assert result["desktopCommand"]["deviceId"] == device["device"]["id"]
    assert result["desktopCommand"]["payload"]["mediaOrderId"] == order["id"]
    assert result["desktopCommand"]["payload"]["publicUrl"] == order["reviewUrl"]
    assert result["desktopCommand"]["payload"]["contentMarkdown"] == article["contentMarkdown"]
    assert result["desktopCommand"]["payload"]["imagePublicationEvidence"]["expectedCount"] == 2
    assert result["desktopCommand"]["payload"]["sessionId"] == session["id"]


def test_baijiahao_image_order_recheck_queues_desktop_publication_discovery():
    device, session, account = create_active_baijiahao_account_for_image_recheck()
    article = client.post("/api/articles", json={
        "title": "Baijiahao illustrated article",
        "contentMarkdown": "Illustrated article body for authenticated public verification.",
        "status": "ready",
    }).json()
    evidence = verified_image_publication_evidence()
    evidence["status"] = "review_required"
    evidence["public"] = {**evidence["public"], "status": "failed", "verifiedCount": 0, "images": []}
    evidence["issues"] = ["PUBLIC_IMAGE_MISSING"]
    order = client.post("/api/media-orders", json={
        "articleId": article["id"],
        "articleTitle": article["title"],
        "accountId": account["id"],
        "platform": "baijiahao",
        "status": "review_required",
        "reviewStatus": "pending_public_visibility",
        "reviewUrl": "https://baijiahao.baidu.com/s?id=1870656649915477340",
        "imagePublicationEvidence": evidence,
    }).json()

    result = client.post("/api/media-orders/recheck-publication", json={
        "orderId": order["id"],
        "provider": "Google",
        "checkImmediately": True,
    }).json()

    assert result["queued"] is True
    assert result["task"] is None
    assert result["desktopCommand"]["type"] == "discover_publication"
    assert result["desktopCommand"]["deviceId"] == device["device"]["id"]
    assert result["desktopCommand"]["payload"]["mediaOrderId"] == order["id"]
    assert result["desktopCommand"]["payload"]["publicUrl"] == order["reviewUrl"]
    assert result["desktopCommand"]["payload"]["contentMarkdown"] == article["contentMarkdown"]
    assert result["desktopCommand"]["payload"]["imagePublicationEvidence"]["expectedCount"] == 2
    assert result["desktopCommand"]["payload"]["sessionId"] == session["id"]


def _create_active_image_recheck_account(platform: str, current_url: str, title: str):
    device = client.post("/api/desktop-devices/register", json={
        "deviceName": f"{platform} Image Recheck Desktop",
        "platform": "windows",
        "appVersion": "0.1.0",
        "publicKey": "desktop-public-key",
    }).json()
    session = client.post("/api/media-auth-sessions", json={
        "platform": platform,
        "deviceId": device["device"]["id"],
        "queueDesktopCommand": False,
    }).json()["session"]
    client.post(
        f"/api/desktop-devices/{device['device']['id']}/media-auth-sessions/{session['id']}/claim",
        json={"pairingCode": session["pairingCode"], "deviceToken": device["deviceToken"]},
    )
    client.post(f"/api/media-auth-sessions/{session['id']}/artifacts", json={
        "deviceId": device["device"]["id"],
        "accountName": f"{platform} image account",
        "artifact": {
            "cookies": "encrypted-cookie-payload",
            "localStorage": "encrypted-local-storage",
            "sessionStorage": "encrypted-session-storage",
            "fingerprint": f"sha256-{platform}-image-recheck",
            "authorizationEvidence": {
                "strongCookiePresent": True,
                "workspaceReady": True,
                "currentUrl": current_url,
                "pageTitle": title,
            },
        },
    })
    account = client.post(
        f"/api/media-auth-sessions/{session['id']}/bind",
        json={"name": f"{platform} image account"},
    ).json()["mediaAccount"]
    return device, session, account


@pytest.mark.parametrize("platform,review_url,current_url,title", [
    ("penguin", "https://om.qq.com/s/article/penguin-article-001", "https://om.qq.com/article/create", "企鹅号创作中心"),
    ("toutiao", "https://www.toutiao.com/article/1234567890/", "https://mp.toutiao.com/profile_v4/graphic/publish", "头条号创作中心"),
    ("jianshu", "https://www.jianshu.com/p/abcdef123456", "https://www.jianshu.com/writer", "简书写作"),
    ("sohu", "https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?contentStatus=1&newsId=1050202888", "https://mp.sohu.com/mpfe/v4/contentManagement/news/articlelist", "Sohu creator center"),
    ("netease", "https://www.163.com/dy/article/NETEASE001.html", "https://mp.163.com/#/article/manage", "网易号内容管理"),
])
def test_free_media_image_order_recheck_queues_desktop_publication_discovery(
    platform,
    review_url,
    current_url,
    title,
):
    device, session, account = _create_active_image_recheck_account(platform, current_url, title)
    article = client.post("/api/articles", json={
        "title": f"{platform} illustrated article",
        "contentMarkdown": "Illustrated article body for authenticated public verification.",
        "status": "ready",
    }).json()
    evidence = verified_image_publication_evidence()
    evidence["status"] = "review_required"
    evidence["public"] = {**evidence["public"], "status": "failed", "verifiedCount": 0, "images": []}
    evidence["issues"] = ["PUBLIC_IMAGE_MISSING"]
    order = client.post("/api/media-orders", json={
        "articleId": article["id"],
        "articleTitle": article["title"],
        "accountId": account["id"],
        "platform": platform,
        "status": "review_required",
        "reviewStatus": "pending_public_visibility",
        "reviewUrl": review_url,
        "imagePublicationEvidence": evidence,
    }).json()

    result = client.post("/api/media-orders/recheck-publication", json={
        "orderId": order["id"],
        "provider": "Google",
        "checkImmediately": True,
    }).json()

    assert result["queued"] is True
    assert result["task"] is None
    assert result["desktopCommand"]["type"] == "discover_publication"
    assert result["desktopCommand"]["deviceId"] == device["device"]["id"]
    assert result["desktopCommand"]["payload"]["mediaOrderId"] == order["id"]
    assert result["desktopCommand"]["payload"]["publicUrl"] == review_url
    assert result["desktopCommand"]["payload"]["platform"] == platform
    assert result["desktopCommand"]["payload"]["imagePublicationEvidence"]["expectedCount"] == 2
    assert result["desktopCommand"]["payload"]["sessionId"] == session["id"]


def test_penguin_image_order_without_public_url_queues_management_discovery():
    device, session, account = _create_active_image_recheck_account(
        "penguin",
        "https://om.qq.com/main/creation/article",
        "Penguin creator center",
    )
    article = client.post("/api/articles", json={
        "title": "Penguin pending illustrated article",
        "contentMarkdown": "The article is saved and submitted but still needs a public URL from content management.",
        "status": "ready",
    }).json()
    evidence = verified_image_publication_evidence()
    evidence["status"] = "review_required"
    evidence["public"] = {**evidence["public"], "status": "failed", "verifiedCount": 0, "images": []}
    evidence["issues"] = ["PUBLIC_IMAGE_MISSING"]
    order = client.post("/api/media-orders", json={
        "articleId": article["id"],
        "articleTitle": article["title"],
        "accountId": account["id"],
        "platform": "penguin",
        "status": "review_required",
        "reviewStatus": "pending_public_visibility",
        "reviewUrl": "",
        "imagePublicationEvidence": evidence,
    }).json()

    result = client.post("/api/media-orders/recheck-publication", json={
        "orderId": order["id"],
        "provider": "Google",
        "checkImmediately": True,
    }).json()

    assert result["queued"] is True
    assert result["task"] is None
    assert result["desktopCommand"]["type"] == "discover_publication"
    assert result["desktopCommand"]["deviceId"] == device["device"]["id"]
    assert result["desktopCommand"]["payload"]["publicUrl"] == ""
    assert result["desktopCommand"]["payload"]["sessionId"] == session["id"]


def test_penguin_review_order_without_callback_evidence_still_queues_management_discovery():
    device, session, account = _create_active_image_recheck_account(
        "penguin",
        "https://om.qq.com/main/creation/article",
        "Penguin creator center",
    )
    article = client.post("/api/articles", json={
        "title": "Penguin callback recovery article",
        "contentMarkdown": "The platform accepted this article before the desktop callback completed.",
        "status": "ready",
    }).json()
    order = client.post("/api/media-orders", json={
        "articleId": article["id"],
        "articleTitle": article["title"],
        "accountId": account["id"],
        "platform": "penguin",
        "status": "review_required",
        "platformStatus": "submitted_for_review",
        "reviewStatus": "pending_public_visibility",
        "reviewUrl": "",
    }).json()

    result = client.post("/api/media-orders/recheck-publication", json={
        "orderId": order["id"],
        "provider": "DataForSEO",
        "checkImmediately": True,
    }).json()

    assert result["queued"] is True
    assert result["task"] is None
    assert result["desktopCommand"]["type"] == "discover_publication"
    assert result["desktopCommand"]["deviceId"] == device["device"]["id"]
    assert result["desktopCommand"]["payload"]["publicUrl"] == ""
    assert result["desktopCommand"]["payload"]["sessionId"] == session["id"]


def test_forced_publication_discovery_does_not_reuse_an_old_running_command():
    _device, _session, account = _create_active_image_recheck_account(
        "penguin",
        "https://om.qq.com/main/creation/article",
        "Penguin creator center",
    )
    article = client.post("/api/articles", json={
        "title": "Forced publication discovery",
        "contentMarkdown": "A forced retry must create a fresh desktop command.",
        "status": "ready",
    }).json()
    order = client.post("/api/media-orders", json={
        "articleId": article["id"],
        "articleTitle": article["title"],
        "accountId": account["id"],
        "platform": "penguin",
        "status": "review_required",
        "reviewUrl": "",
    }).json()
    first = client.post("/api/media-orders/recheck-publication", json={
        "orderId": order["id"],
    }).json()
    forced = client.post("/api/media-orders/recheck-publication", json={
        "orderId": order["id"],
        "forceDiscovery": True,
    }).json()

    assert forced["desktopCommand"]["id"] != first["desktopCommand"]["id"]
    assert forced["deduplicated"] is False


def test_publication_discovery_expires_stale_running_command_before_queueing_retry():
    _device, _session, account = _create_active_image_recheck_account(
        "penguin",
        "https://om.qq.com/main/creation/article",
        "Penguin creator center",
    )
    article = client.post("/api/articles", json={
        "title": "Stale publication discovery",
        "contentMarkdown": "A stale desktop discovery command must not block the next retry.",
        "status": "ready",
    }).json()
    order = client.post("/api/media-orders", json={
        "articleId": article["id"],
        "articleTitle": article["title"],
        "accountId": account["id"],
        "platform": "penguin",
        "status": "review_required",
        "reviewStatus": "pending_public_visibility",
        "reviewUrl": "",
    }).json()
    first = client.post("/api/media-orders/recheck-publication", json={
        "orderId": order["id"],
    }).json()
    with SessionLocal() as db:
        command_row = db.get(Record, first["desktopCommand"]["id"])
        assert command_row is not None
        command_row.data = {
            **command_row.data,
            "status": "running",
            "updatedAt": "2026-07-25T00:00:00",
        }
        db.commit()

    retried = client.post("/api/media-orders/recheck-publication", json={
        "orderId": order["id"],
    }).json()

    assert retried["deduplicated"] is False
    assert retried["desktopCommand"]["id"] != first["desktopCommand"]["id"]
    with SessionLocal() as db:
        old_command = get_record(db, "desktopCommands", first["desktopCommand"]["id"])
    assert old_command["status"] == "failed"
    assert old_command["errorMessage"] == "DESKTOP_COMMAND_STALE_TIMEOUT"


def test_publication_discovery_requeues_command_bound_to_old_runner_device():
    device, _session, account = _create_active_image_recheck_account(
        "sohu",
        "https://mp.sohu.com/mpfe/v4/contentManagement/news/articlelist",
        "Sohu creator center",
    )
    article = client.post("/api/articles", json={
        "title": "Sohu stale runner discovery",
        "contentMarkdown": "A stale runner-bound discovery command must not block a current active runner.",
        "status": "ready",
    }).json()
    order = client.post("/api/media-orders", json={
        "articleId": article["id"],
        "articleTitle": article["title"],
        "accountId": account["id"],
        "platform": "sohu",
        "status": "review_required",
        "reviewStatus": "pending_public_visibility",
        "reviewUrl": "https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?newsId=1050202888",
    }).json()
    with SessionLocal() as db:
        old_command = save_record(db, "desktopCommands", {
            "id": "desktop-command-old-sohu-discovery-runner",
            "deviceId": "desktop-device-old-token-lost",
            "type": "discover_publication",
            "mediaAccountId": account["id"],
            "payload": {"mediaOrderId": order["id"]},
            "status": "queued",
            "result": {},
            "errorMessage": "",
            "createdAt": "2026-07-25T00:00:00",
            "updatedAt": "2026-07-25T00:00:00",
        })

    retried = client.post("/api/media-orders/recheck-publication", json={
        "orderId": order["id"],
    }).json()

    assert retried["deduplicated"] is False
    assert retried["desktopCommand"]["id"] != old_command["id"]
    assert retried["desktopCommand"]["deviceId"] == device["device"]["id"]
    with SessionLocal() as db:
        stale = get_record(db, "desktopCommands", old_command["id"])
    assert stale["status"] == "failed"
    assert stale["errorMessage"] == "DESKTOP_COMMAND_STALE_DEVICE"


def test_publication_discovery_defaults_to_latest_active_desktop_device_when_binding_is_stale():
    old_device, _session, account = _create_active_image_recheck_account(
        "sohu",
        "https://mp.sohu.com/mpfe/v4/contentManagement/news/articlelist",
        "Sohu creator center",
    )
    with SessionLocal() as db:
        patch_record(db, "desktopDevices", old_device["device"]["id"], {"lastSeenAt": "07/17 10:00", "updatedAt": "07/17 10:00"})
        current_device = save_record(db, "desktopDevices", {
            "id": "desktop-device-current-sohu-discovery",
            "deviceName": "Current Sohu discovery desktop",
            "platform": "windows",
            "appVersion": "0.2.0",
            "publicKey": "desktop-public-key",
            "deviceTokenHash": "current-discovery-token-hash",
            "status": "active",
            "ownerId": old_device["device"].get("ownerId") or "",
            "boundOwnerId": old_device["device"].get("boundOwnerId") or "",
            "lastSeenAt": "07/18 10:00",
            "createdAt": "07/18 09:59",
            "updatedAt": "07/18 10:00",
        })
    article = client.post("/api/articles", json={
        "title": "Sohu latest discovery route",
        "contentMarkdown": "Discovery should follow the current active desktop for this installation.",
        "status": "ready",
    }).json()
    order = client.post("/api/media-orders", json={
        "articleId": article["id"],
        "articleTitle": article["title"],
        "accountId": account["id"],
        "platform": "sohu",
        "status": "review_required",
        "reviewStatus": "pending_public_visibility",
        "reviewUrl": "https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?newsId=1050202888",
    }).json()

    result = client.post("/api/media-orders/recheck-publication", json={
        "orderId": order["id"],
    }).json()

    assert result["desktopCommand"]["deviceId"] == current_device["id"]
    with SessionLocal() as db:
        bindings = [
            item for item in list_records(db, "mediaAccountBindings")
            if item.get("mediaAccountId") == account["id"] and item.get("status") == "active"
        ]
    assert bindings[-1]["deviceId"] == current_device["id"]


def test_zhihu_desktop_image_recheck_upgrades_original_order_without_index_submission(monkeypatch):
    device, _session, account = create_active_zhihu_account_for_image_recheck()
    article = client.post("/api/articles", json={
        "title": "Zhihu verified illustrated article",
        "contentMarkdown": "The body is verified by the authenticated desktop page.",
        "status": "ready",
    }).json()
    incomplete = verified_image_publication_evidence()
    incomplete["status"] = "review_required"
    incomplete["public"] = {**incomplete["public"], "status": "failed", "verifiedCount": 0, "images": []}
    incomplete["issues"] = ["PUBLIC_IMAGE_MISSING"]
    order = client.post("/api/media-orders", json={
        "articleId": article["id"],
        "articleTitle": article["title"],
        "accountId": account["id"],
        "platform": "zhihu",
        "status": "review_required",
        "reviewUrl": "https://zhuanlan.zhihu.com/p/987654321",
        "imagePublicationEvidence": incomplete,
    }).json()
    queued = client.post("/api/media-orders/recheck-publication", json={"orderId": order["id"], "provider": "Google"}).json()
    command = queued["desktopCommand"]
    monkeypatch.setattr("app.service.fetch_public_page_text", lambda _url: (_ for _ in ()).throw(AssertionError("desktop pageText should be used")))

    completed = client.post(f"/api/desktop-commands/{command['id']}/events", json={
        "deviceId": device["device"]["id"],
        "deviceToken": device["deviceToken"],
        "type": "publication_discovery_succeeded",
        "payload": {
            "found": True,
            "publicUrl": order["reviewUrl"],
            "pageText": f"{article['title']} {article['contentMarkdown']}",
            "imagePublicationEvidence": verified_image_publication_evidence(),
        },
    }).json()

    assert completed["command"]["status"] == "succeeded"
    assert completed["mediaOrder"]["id"] == order["id"]
    assert completed["mediaOrder"]["status"] == "succeeded"
    assert completed["mediaOrder"]["imagePublicationEvidence"]["status"] == "verified"
    assert completed["indexSubmission"] is None


def public_only_image_publication_evidence():
    """What a desktop recheck returns when the publish attempt never recorded upload/draft images."""
    evidence = verified_image_publication_evidence()
    for stage_name in ["upload", "draft"]:
        evidence[stage_name] = {
            "stage": stage_name,
            "expectedCount": 2,
            "observedCount": 0,
            "verifiedCount": 0,
            "status": "failed",
            "images": [],
        }
    evidence["status"] = "review_required"
    evidence["issues"] = ["UPLOAD_IMAGE_MISSING", "DRAFT_IMAGE_MISSING"]
    evidence["verifiedAt"] = ""
    return evidence


def test_zhihu_desktop_recheck_recovers_order_without_upload_or_draft_image_evidence(monkeypatch):
    device, _session, account = create_active_zhihu_account_for_image_recheck()
    article = client.post("/api/articles", json={
        "title": "Zhihu published before image evidence was recorded",
        "contentMarkdown": "The article is live but the draft was deleted before evidence landed.",
        "status": "ready",
    }).json()
    order = client.post("/api/media-orders", json={
        "articleId": article["id"],
        "articleTitle": article["title"],
        "accountId": account["id"],
        "platform": "zhihu",
        "status": "review_required",
        "reviewUrl": "https://zhuanlan.zhihu.com/p/2090113203183284966",
        "imagePublicationEvidence": public_only_image_publication_evidence(),
    }).json()
    queued = client.post("/api/media-orders/recheck-publication", json={
        "orderId": order["id"],
        "url": order["reviewUrl"],
        "provider": "Google",
    }).json()
    command = queued["desktopCommand"]
    monkeypatch.setattr("app.service.fetch_public_page_text", lambda _url: (_ for _ in ()).throw(AssertionError("desktop pageText should be used")))

    completed = client.post(f"/api/desktop-commands/{command['id']}/events", json={
        "deviceId": device["device"]["id"],
        "deviceToken": device["deviceToken"],
        "type": "publication_discovery_succeeded",
        "payload": {
            "found": True,
            "publicUrl": order["reviewUrl"],
            "pageText": f"{article['title']} {article['contentMarkdown']}",
            "imagePublicationEvidence": public_only_image_publication_evidence(),
        },
    }).json()

    assert completed["command"]["status"] == "succeeded"
    assert completed["mediaOrder"]["id"] == order["id"]
    assert completed["mediaOrder"]["status"] == "succeeded"
    assert completed["mediaOrder"]["backlinkUrl"] == order["reviewUrl"]
    assert completed["mediaOrder"]["publicDiscoveryStatus"] == "candidate_found"
    assert completed["command"]["result"]["verificationReason"] == "PUBLIC_PAGE_MATCHED"
    recovered = completed["mediaOrder"]["imagePublicationEvidence"]
    assert recovered["status"] == "verified"
    assert recovered["issues"] == []
    assert recovered["upload"]["status"] == "not_observed"
    assert recovered["draft"]["status"] == "not_observed"
    assert recovered["public"]["status"] == "verified"
    assert completed["indexSubmission"] is None
    with SessionLocal() as db:
        article_after = get_record(db, "articles", article["id"])
    assert article_after["publishedUrl"] == order["reviewUrl"]


def test_zhihu_desktop_recheck_still_blocks_partial_upload_image_evidence(monkeypatch):
    device, _session, account = create_active_zhihu_account_for_image_recheck()
    article = client.post("/api/articles", json={
        "title": "Zhihu article with a partial upload observation",
        "contentMarkdown": "Only one of the two images ever reached the platform upload stage.",
        "status": "ready",
    }).json()
    partial = public_only_image_publication_evidence()
    observed = verified_image_publication_evidence()["expected"][0]
    partial["upload"] = {
        **partial["upload"],
        "observedCount": 1,
        "images": [{**observed, "platformImageUrl": "https://picx.zhimg.com/a.png", "loaded": True}],
    }
    order = client.post("/api/media-orders", json={
        "articleId": article["id"],
        "articleTitle": article["title"],
        "accountId": account["id"],
        "platform": "zhihu",
        "status": "review_required",
        "reviewUrl": "https://zhuanlan.zhihu.com/p/2090113203183284966",
        "imagePublicationEvidence": partial,
    }).json()
    queued = client.post("/api/media-orders/recheck-publication", json={"orderId": order["id"], "url": order["reviewUrl"]}).json()
    command = queued["desktopCommand"]
    monkeypatch.setattr("app.service.fetch_public_page_text", lambda _url: (_ for _ in ()).throw(AssertionError("desktop pageText should be used")))

    completed = client.post(f"/api/desktop-commands/{command['id']}/events", json={
        "deviceId": device["device"]["id"],
        "deviceToken": device["deviceToken"],
        "type": "publication_discovery_succeeded",
        "payload": {
            "found": True,
            "publicUrl": order["reviewUrl"],
            "pageText": f"{article['title']} {article['contentMarkdown']}",
            "imagePublicationEvidence": partial,
        },
    }).json()

    assert completed["command"]["status"] == "succeeded"
    assert completed["command"]["result"]["verificationReason"] == "PUBLIC_IMAGE_EVIDENCE_INVALID"
    assert completed["mediaOrder"]["status"] == "review_required"
    assert completed["mediaOrder"]["errorMessage"] == "公开页已找到，但正文图片持久化证据不完整。"


def test_recover_public_only_image_publication_evidence_marks_unobserved_stages():
    verified = verified_image_publication_evidence()
    order = {"imagePublicationEvidence": {}}
    evidence = {
        "status": "review_required",
        "expectedCount": verified["expectedCount"],
        "issues": ["UPLOAD_IMAGE_MISSING", "DRAFT_IMAGE_MISSING"],
        "public": verified["public"],
    }

    recovered = recover_public_only_image_publication_evidence(order, evidence)

    assert recovered["status"] == "verified"
    assert recovered["issues"] == []
    assert recovered["upload"] == {"status": "not_observed", "observedCount": 0, "verifiedCount": 0, "images": []}
    assert recovered["draft"]["status"] == "not_observed"
    assert recovered["expectedCount"] == verified["expectedCount"]
    assert recovered["public"] is verified["public"]
    assert evidence["status"] == "review_required"


def test_recover_public_only_image_publication_evidence_keeps_failed_public_stage_blocked():
    evidence = public_only_image_publication_evidence()
    evidence["public"] = {**evidence["public"], "status": "failed", "verifiedCount": 0, "images": []}
    evidence["issues"] = ["PUBLIC_IMAGE_MISSING"]

    recovered = recover_public_only_image_publication_evidence({"imagePublicationEvidence": {}}, evidence)

    assert recovered["status"] == "review_required"
    assert recovered["issues"] == ["PUBLIC_IMAGE_MISSING"]
    assert recovered["upload"]["status"] == "not_observed"
    assert recovered["public"]["status"] == "failed"
def test_media_order_recheck_queues_desktop_discovery_when_netease_public_url_is_missing():
    device, session, account = create_active_netease_account_for_publication_discovery()
    article = client.post("/api/articles", json={
        "title": "网易号等待公开 URL 的文章",
        "contentMarkdown": "这是等待网易号审核后从内容管理发现真实公开链接的正文。",
        "status": "ready",
    }).json()
    order = client.post("/api/media-orders", json={
        "articleId": article["id"],
        "articleTitle": article["title"],
        "accountId": account["id"],
        "platform": "netease",
        "status": "review_required",
        "reviewStatus": "pending_public_visibility",
    }).json()

    result = client.post("/api/media-orders/recheck-publication", json={
        "orderId": order["id"],
        "provider": "Google",
        "checkImmediately": True,
    }).json()

    assert result["queued"] is True
    assert result["task"] is None
    assert result["desktopCommand"]["type"] == "discover_publication"
    assert result["desktopCommand"]["deviceId"] == device["device"]["id"]
    assert result["desktopCommand"]["mediaAccountId"] == account["id"]
    assert result["desktopCommand"]["payload"]["mediaOrderId"] == order["id"]
    assert result["desktopCommand"]["payload"]["sessionId"] == session["id"]
    center_record = next(item for item in client.get("/api/published-center").json()["records"] if item["sourceId"] == order["id"])
    assert center_record["platform"] == "netease"
    assert center_record["mediaAccountId"] == account["id"]
    assert center_record["publicDiscoveryStatus"] == "queued"


def test_media_order_recheck_clears_stale_desktop_discovery_error():
    _device, _session, account = create_active_netease_account_for_publication_discovery()
    article = client.post("/api/articles", json={
        "title": "Netease stale discovery error",
        "contentMarkdown": "This article is waiting for public URL discovery.",
        "status": "ready",
    }).json()

    order = client.post("/api/media-orders", json={
        "articleTitle": "Netease stale discovery error",
        "articleId": article["id"],
        "accountId": account["id"],
        "platform": "netease",
        "status": "review_required",
        "reviewStatus": "pending_public_visibility",
        "publicDiscoveryStatus": "failed",
        "errorMessage": "browserType.launchPersistentContext: Executable doesn't exist",
    }).json()

    result = client.post("/api/media-orders/recheck-publication", json={
        "orderId": order["id"],
        "provider": "Google",
        "checkImmediately": True,
    }).json()

    assert result["queued"] is True
    assert result["mediaOrder"]["publicDiscoveryStatus"] == "queued"
    assert result["mediaOrder"]["errorMessage"] == ""
    center_record = next(
        item for item in client.get("/api/published-center").json()["records"]
        if item["sourceId"] == order["id"]
    )
    assert center_record["publicDiscoveryStatus"] == "queued"
    assert center_record["errorMessage"] == ""




def test_publication_discovery_failure_hides_playwright_installation_details():
    device, session, account = create_active_netease_account_for_publication_discovery()
    order = client.post("/api/media-orders", json={
        "articleTitle": "Netease discovery runtime failure",
        "accountId": account["id"],
        "platform": "netease",
        "status": "review_required",
        "reviewStatus": "pending_public_visibility",
    }).json()
    command = client.post("/api/desktop-commands", json={
        "deviceId": device["device"]["id"],
        "type": "discover_publication",
        "mediaAccountId": account["id"],
        "payload": {
            "mediaOrderId": order["id"],
            "articleTitle": order["articleTitle"],
            "platform": "netease",
            "sessionId": session["id"],
        },
    }).json()

    completed = client.post(f"/api/desktop-commands/{command['id']}/events", json={
        "deviceId": device["device"]["id"],
        "deviceToken": device["deviceToken"],
        "type": "publication_discovery_failed",
        "payload": {
            "errorMessage": "browserType.launchPersistentContext: Executable doesn't exist at D:\\ZhixinAI\\resources\\browsers\\chromium_headless_shell-1228\\chrome-headless-shell.exe",
        },
    }).json()

    assert completed["mediaOrder"]["publicDiscoveryStatus"] == "failed"
    assert completed["mediaOrder"]["errorMessage"] == "\u684c\u9762\u7aef\u6d4f\u89c8\u5668\u7ec4\u4ef6\u4e0d\u53ef\u7528\uff0c\u8bf7\u66f4\u65b0\u684c\u9762\u7aef\u540e\u91cd\u65b0\u53d1\u73b0\u516c\u5f00 URL\u3002"
    assert "chrome-headless-shell.exe" not in completed["mediaOrder"]["errorMessage"]


def test_media_order_recheck_reconciles_stale_error_when_discovery_is_already_queued():
    device, session, account = create_active_netease_account_for_publication_discovery()
    order = client.post("/api/media-orders", json={
        "articleTitle": "Netease queued discovery with stale error",
        "accountId": account["id"],
        "platform": "netease",
        "status": "review_required",
        "reviewStatus": "pending_public_visibility",
        "publicDiscoveryStatus": "failed",
        "errorMessage": "legacy desktop runtime failure",
    }).json()
    client.post("/api/desktop-commands", json={
        "deviceId": device["device"]["id"],
        "type": "discover_publication",
        "mediaAccountId": account["id"],
        "payload": {
            "mediaOrderId": order["id"],
            "articleTitle": order["articleTitle"],
            "platform": "netease",
            "sessionId": session["id"],
        },
    }).json()

    result = client.post("/api/media-orders/recheck-publication", json={
        "orderId": order["id"],
        "provider": "Google",
        "checkImmediately": True,
    }).json()

    assert result["deduplicated"] is True
    assert result["mediaOrder"]["publicDiscoveryStatus"] == "queued"
    assert result["mediaOrder"]["errorMessage"] == ""
def test_sohu_submitted_review_url_queues_publication_discovery():
    device, session, account = create_active_sohu_account_for_publication_discovery()
    article = client.post("/api/articles", json={
        "title": "Sohu pending public URL discovery",
        "contentMarkdown": "This article waits for Sohu review and public URL discovery.",
        "status": "ready",
    }).json()
    order = client.post("/api/media-orders", json={
        "articleId": article["id"],
        "articleTitle": article["title"],
        "accountId": account["id"],
        "platform": "sohu",
        "status": "review_required",
        "reviewStatus": "pending_public_visibility",
        "reviewUrl": "https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?contentStatus=1&newsId=1051344766",
        "platformStatus": "submitted_for_review",
        "publicDiscoveryStatus": "pending",
    }).json()

    result = client.post("/api/media-orders/recheck-publication", json={
        "orderId": order["id"],
        "provider": "Google",
        "checkImmediately": True,
    }).json()

    assert result["queued"] is True
    assert result["task"] is None
    assert result["desktopCommand"]["type"] == "discover_publication"
    assert result["desktopCommand"]["deviceId"] == device["device"]["id"]
    assert result["desktopCommand"]["mediaAccountId"] == account["id"]
    assert result["desktopCommand"]["payload"]["mediaOrderId"] == order["id"]
    assert result["desktopCommand"]["payload"]["sessionId"] == session["id"]
    assert result["desktopCommand"]["payload"]["publicUrl"] == order["reviewUrl"]


def test_sohu_submitted_publish_marks_order_pending_public_discovery():
    device, _session, account = create_active_sohu_account_for_publication_discovery()
    article = client.post("/api/articles", json={
        "title": "Sohu submitted review creates discoverable order",
        "contentMarkdown": "This verifies Sohu submitted review orders are discoverable.",
        "status": "ready",
    }).json()
    queued = client.post(f"/api/articles/{article['id']}/publish-from-context", json={
        "targetId": f"media:{account['id']}",
        "provider": "Google",
        "checkImmediately": True,
        "confirmPublish": True,
        "publishMode": "publish",
    }).json()
    command = queued["desktopCommand"]

    completed = client.post(f"/api/desktop-commands/{command['id']}/events", json={
        "deviceId": device["device"]["id"],
        "deviceToken": device["deviceToken"],
        "type": "publish_succeeded",
        "payload": {
            "draftUrl": "https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?contentStatus=1&newsId=1051344766",
            "reviewUrl": "https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?contentStatus=1&newsId=1051344766",
            "publishedUrl": "",
            "platformStatus": "submitted_for_review",
            "reviewStatus": "pending_public_visibility",
            "publiclyVisible": False,
        },
    }).json()

    assert completed["mediaOrder"]["status"] == "review_required"
    assert completed["mediaOrder"]["backlinkUrl"] == ""
    assert completed["mediaOrder"]["publicDiscoveryStatus"] == "pending"
    assert completed["indexSubmission"] is None
    updated_article = client.get(f"/api/articles/{article['id']}").json()
    assert updated_article["status"] == "ready"
    assert updated_article["publishStatus"] == "submitted_for_review"
    assert updated_article["publicationStatus"] == "review_required"
    assert updated_article["mediaPublishStatus"] == "review_required"
    assert updated_article["mediaBacklinkStatus"] == "reviewing"
    assert updated_article["mediaOrderId"] == completed["mediaOrder"]["id"]
    assert updated_article["mediaAccountId"] == account["id"]
    assert updated_article["mediaPlatform"] == "sohu"
    assert updated_article["mediaReviewUrl"] == "https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?contentStatus=1&newsId=1051344766"
    assert updated_article["mediaPublicDiscoveryStatus"] == "pending"


def test_sohu_rejected_publication_discovery_marks_order_failed_without_backlink():
    device, session, account = create_active_sohu_account_for_publication_discovery()
    article = client.post("/api/articles", json={
        "title": "Sohu rejected article must not keep a backlink",
        "contentMarkdown": "This article is rejected by Sohu and must not expose a creator URL.",
        "status": "ready",
    }).json()
    order = client.post("/api/media-orders", json={
        "articleId": article["id"],
        "articleTitle": article["title"],
        "accountId": account["id"],
        "platform": "sohu",
        "status": "review_required",
        "reviewStatus": "pending_public_visibility",
        "reviewUrl": "https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?contentStatus=1&newsId=1051344766",
        "platformStatus": "submitted_for_review",
        "publicDiscoveryStatus": "pending",
    }).json()
    command = client.post("/api/desktop-commands", json={
        "deviceId": device["device"]["id"],
        "type": "discover_publication",
        "mediaAccountId": account["id"],
        "payload": {
            "mediaOrderId": order["id"],
            "articleId": article["id"],
            "articleTitle": article["title"],
            "platform": "sohu",
            "sessionId": session["id"],
        },
    }).json()

    completed = client.post(f"/api/desktop-commands/{command['id']}/events", json={
        "deviceId": device["device"]["id"],
        "deviceToken": device["deviceToken"],
        "type": "publication_discovery_succeeded",
        "payload": {
            "found": False,
            "publicUrl": "",
            "publishedUrl": "",
            "platformStatus": "rejected",
            "reviewStatus": "rejected",
            "publiclyVisible": False,
            "message": "搜狐号审核未通过，平台未生成公开文章 URL。",
            "managementEvidence": {
                "found": True,
                "statusText": f"{article['title']} 未通过",
                "rowText": f"{article['title']} 未通过 栏目0 更多",
            },
        },
    }).json()

    assert completed["command"]["status"] == "succeeded"
    assert completed["command"]["result"]["verified"] is False
    assert completed["command"]["result"]["verificationReason"] == "PUBLICATION_REJECTED"
    assert completed["mediaOrder"]["id"] == order["id"]
    assert completed["mediaOrder"]["status"] == "failed"
    assert completed["mediaOrder"]["platformStatus"] == "rejected"
    assert completed["mediaOrder"]["reviewStatus"] == "rejected"
    assert completed["mediaOrder"]["backlinkStatus"] == "failed"
    assert completed["mediaOrder"]["backlinkUrl"] == ""
    assert completed["mediaOrder"]["reviewUrl"] == ""
    assert completed["mediaOrder"]["publicDiscoveryStatus"] == "failed"
    assert "审核未通过" in completed["mediaOrder"]["errorMessage"]
    updated_article = client.get(f"/api/articles/{article['id']}").json()
    assert updated_article["publicationStatus"] == "failed"
    assert updated_article["mediaPublishStatus"] == "failed"
    assert updated_article["mediaBacklinkStatus"] == "failed"
    assert updated_article["mediaPublishedUrl"] == ""
    assert updated_article["mediaReviewUrl"] == ""
    assert updated_article["mediaPublicDiscoveryStatus"] == "failed"


def test_sohu_rejected_publish_result_creates_failed_order_without_review_url():
    device, _session, account = create_active_sohu_account_for_publication_discovery()
    article = client.post("/api/articles", json={
        "title": "Sohu rejected publish result",
        "contentMarkdown": "This publish result is rejected before a public URL exists.",
        "status": "ready",
    }).json()
    queued = client.post(f"/api/articles/{article['id']}/publish-from-context", json={
        "targetId": f"media:{account['id']}",
        "provider": "Google",
        "checkImmediately": True,
        "confirmPublish": True,
        "publishMode": "publish",
    }).json()
    command = queued["desktopCommand"]

    completed = client.post(f"/api/desktop-commands/{command['id']}/events", json={
        "deviceId": device["device"]["id"],
        "deviceToken": device["deviceToken"],
        "type": "publish_succeeded",
        "payload": {
            "publishedUrl": "",
            "reviewUrl": "https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?contentStatus=1&newsId=1051344766",
            "platformStatus": "rejected",
            "reviewStatus": "rejected",
            "publiclyVisible": False,
            "message": "搜狐号审核未通过，平台未生成公开文章 URL。",
        },
    }).json()

    assert completed["mediaOrder"]["status"] == "failed"
    assert completed["mediaOrder"]["backlinkStatus"] == "failed"
    assert completed["mediaOrder"]["backlinkUrl"] == ""
    assert completed["mediaOrder"]["reviewUrl"] == ""
    assert completed["mediaOrder"]["platformStatus"] == "rejected"
    assert completed["mediaOrder"]["reviewStatus"] == "rejected"
    assert completed["mediaOrder"]["publicDiscoveryStatus"] == "failed"
    updated_article = client.get(f"/api/articles/{article['id']}").json()
    assert updated_article["publicationStatus"] == "failed"
    assert updated_article["mediaPublishStatus"] == "failed"
    assert updated_article["mediaBacklinkStatus"] == "failed"
    assert updated_article["mediaPublishedUrl"] == ""
    assert updated_article["mediaReviewUrl"] == ""


def test_manual_recheck_prefers_desktop_discovery_after_netease_candidate_failed():
    _device, _session, account = create_active_netease_account_for_publication_discovery()
    order = client.post("/api/media-orders", json={
        "articleTitle": "网易号旧候选 URL 重新发现",
        "accountId": account["id"],
        "platform": "netease",
        "status": "review_required",
        "reviewStatus": "pending_public_visibility",
        "reviewUrl": "https://www.163.com/dy/article/STALE_CANDIDATE.html",
        "publicDiscoveryStatus": "failed",
    }).json()

    result = client.post("/api/media-orders/recheck-publication", json={
        "orderId": order["id"],
        "provider": "Google",
        "checkImmediately": True,
    }).json()

    assert result["task"] is None
    assert result["desktopCommand"]["type"] == "discover_publication"
    assert result["desktopCommand"]["payload"]["mediaOrderId"] == order["id"]


def test_publication_discovery_does_not_verify_public_url_when_image_evidence_is_incomplete():
    device, session, account = create_active_sohu_account_for_publication_discovery()
    article = client.post("/api/articles", json={
        "title": "Sohu public page with missing image evidence",
        "contentMarkdown": "This body matches the public page but the platform image proof is still incomplete.",
        "status": "ready",
    }).json()
    order = client.post("/api/media-orders", json={
        "articleId": article["id"],
        "articleTitle": article["title"],
        "accountId": account["id"],
        "platform": "sohu",
        "status": "review_required",
        "reviewStatus": "pending_public_visibility",
        "reviewUrl": "https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?contentStatus=1&newsId=1051344766",
        "imagePublicationEvidence": {
            "version": 1,
            "status": "review_required",
            "issues": ["PUBLIC_IMAGE_MISSING"],
            "public": {"status": "failed", "verifiedCount": 0, "images": []},
        },
    }).json()
    command = client.post("/api/desktop-commands", json={
        "deviceId": device["device"]["id"],
        "type": "discover_publication",
        "mediaAccountId": account["id"],
        "payload": {
            "mediaOrderId": order["id"],
            "articleId": article["id"],
            "articleTitle": article["title"],
            "platform": "sohu",
            "sessionId": session["id"],
        },
    }).json()
    public_url = "https://www.sohu.com/a/1055612980_122929277"

    completed = client.post(f"/api/desktop-commands/{command['id']}/events", json={
        "deviceId": device["device"]["id"],
        "deviceToken": device["deviceToken"],
        "type": "publication_discovery_succeeded",
        "payload": {
            "found": True,
            "publicUrl": public_url,
            "publishedUrl": public_url,
            "platformStatus": "published",
            "publiclyVisible": True,
            "reviewStatus": "public",
            "pageText": f"{article['title']} {article['contentMarkdown']}",
        },
    }).json()

    assert completed["command"]["status"] == "succeeded"
    assert completed["command"]["result"]["verified"] is False
    assert completed["command"]["result"]["verificationReason"] == "PUBLIC_IMAGE_EVIDENCE_INCOMPLETE"
    assert completed["mediaOrder"]["status"] == "review_required"
    assert completed["mediaOrder"]["backlinkUrl"] == ""
    assert completed["mediaOrder"]["reviewUrl"] == public_url
    assert completed["mediaOrder"]["backlinkStatus"] == "reviewing"
    assert completed["mediaOrder"]["reviewStatus"] != "public"
    assert completed["mediaOrder"]["imagePublicationEvidence"]["issues"] == ["PUBLIC_IMAGE_MISSING"]
    assert completed["indexSubmission"] is None
    updated_article = client.get(f"/api/articles/{article['id']}").json()
    assert updated_article["publishedUrl"] == ""
    assert updated_article["publicationStatus"] != "succeeded"
    assert updated_article["mediaBacklinkStatus"] != "generated"


def test_publication_discovery_requires_image_evidence_when_article_has_publish_images():
    device, session, account = create_active_sohu_account_for_publication_discovery()
    article = client.post("/api/articles", json={
        "title": "Sohu public page with absent image evidence",
        "contentMarkdown": "This body matches the public page but image evidence was not reported by the runner.",
        "status": "ready",
        "inlineImages": [{
            "assetId": "asset-inline",
            "sectionId": "s1",
            "url": "/uploads/assets/asset-inline.png",
            "path": "/app/uploads/assets/asset-inline.png",
            "altText": "Inline image",
        }],
        "contentBlocks": [
            {"type": "section", "sectionId": "s1", "title": "Section", "content": "Body"},
            {
                "type": "image",
                "sectionId": "s1",
                "assetId": "asset-inline",
                "url": "/uploads/assets/asset-inline.png",
                "path": "/app/uploads/assets/asset-inline.png",
                "altText": "Inline image",
            },
        ],
    }).json()
    order = client.post("/api/media-orders", json={
        "articleId": article["id"],
        "articleTitle": article["title"],
        "accountId": account["id"],
        "platform": "sohu",
        "status": "review_required",
        "reviewStatus": "pending_public_visibility",
        "reviewUrl": "https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?contentStatus=1&newsId=1051344766",
    }).json()
    command = client.post("/api/desktop-commands", json={
        "deviceId": device["device"]["id"],
        "type": "discover_publication",
        "mediaAccountId": account["id"],
        "payload": {
            "mediaOrderId": order["id"],
            "articleId": article["id"],
            "articleTitle": article["title"],
            "platform": "sohu",
            "sessionId": session["id"],
        },
    }).json()
    public_url = "https://www.sohu.com/a/1055612981_122929277"

    completed = client.post(f"/api/desktop-commands/{command['id']}/events", json={
        "deviceId": device["device"]["id"],
        "deviceToken": device["deviceToken"],
        "type": "publication_discovery_succeeded",
        "payload": {
            "found": True,
            "publicUrl": public_url,
            "publishedUrl": public_url,
            "platformStatus": "published",
            "publiclyVisible": True,
            "reviewStatus": "public",
            "pageText": f"{article['title']} {article['contentMarkdown']}",
        },
    }).json()

    assert completed["command"]["result"]["verified"] is False
    assert completed["command"]["result"]["verificationReason"] == "PUBLIC_IMAGE_EVIDENCE_INCOMPLETE"
    assert completed["mediaOrder"]["status"] == "review_required"
    assert completed["mediaOrder"]["backlinkUrl"] == ""
    assert completed["mediaOrder"]["reviewUrl"] == public_url
    assert completed["indexSubmission"] is None


def test_recheck_publication_seeds_image_evidence_from_article_when_order_is_missing_it():
    _device, _session, account = create_active_sohu_account_for_publication_discovery()
    article = client.post("/api/articles", json={
        "title": "Sohu discovery seeds article images",
        "contentMarkdown": "This article has a structured image that must be verified on the public page.",
        "status": "ready",
        "inlineImages": [{
            "assetId": "asset-inline",
            "sectionId": "s1",
            "url": "/uploads/assets/asset-inline.png",
            "path": "/app/uploads/assets/asset-inline.png",
            "altText": "Inline image",
        }],
        "contentBlocks": [
            {"type": "section", "sectionId": "s1", "title": "Section", "content": "Body"},
            {
                "type": "image",
                "sectionId": "s1",
                "assetId": "asset-inline",
                "url": "/uploads/assets/asset-inline.png",
                "path": "/app/uploads/assets/asset-inline.png",
                "altText": "Inline image",
            },
        ],
    }).json()
    order = client.post("/api/media-orders", json={
        "articleId": article["id"],
        "articleTitle": article["title"],
        "accountId": account["id"],
        "platform": "sohu",
        "status": "review_required",
        "reviewStatus": "pending_public_visibility",
        "reviewUrl": "https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?contentStatus=1&newsId=1051344766",
    }).json()

    result = client.post("/api/media-orders/recheck-publication", json={
        "orderId": order["id"],
        "forceDiscovery": True,
    }).json()

    evidence = result["desktopCommand"]["payload"]["imagePublicationEvidence"]
    assert evidence["status"] == "review_required"
    assert evidence["expectedCount"] == 1
    assert evidence["expected"][0]["assetId"] == "asset-inline"
    assert evidence["expected"][0]["sectionId"] == "s1"


def test_publication_discovery_success_updates_original_order_without_index_submission(monkeypatch):
    device, session, account = create_active_netease_account_for_publication_discovery()
    article = client.post("/api/articles", json={
        "title": "网易号审核后公开发现闭环",
        "contentMarkdown": "这篇文章用于确认桌面发现公开 URL 后会复验并回写发布记录。",
        "status": "ready",
    }).json()
    order = client.post("/api/media-orders", json={
        "articleId": article["id"],
        "articleTitle": article["title"],
        "accountId": account["id"],
        "platform": "netease",
        "status": "review_required",
        "reviewStatus": "pending_public_visibility",
    }).json()
    command = client.post("/api/desktop-commands", json={
        "deviceId": device["device"]["id"],
        "type": "discover_publication",
        "mediaAccountId": account["id"],
        "payload": {
            "mediaOrderId": order["id"],
            "articleId": article["id"],
            "articleTitle": article["title"],
            "platform": "netease",
            "sessionId": session["id"],
            "provider": "Google",
            "checkImmediately": False,
        },
    }).json()
    from app.service import verify_media_order_publication as real_verify

    monkeypatch.setattr(main_module, "verify_media_order_publication", lambda db, payload: real_verify(
        db,
        payload,
        url_fetcher=lambda _url: f"{article['title']} {article['contentMarkdown']}",
    ))
    public_url = "https://www.163.com/dy/article/NETEASE_DISCOVERED.html"

    completed = client.post(f"/api/desktop-commands/{command['id']}/events", json={
        "deviceId": device["device"]["id"],
        "deviceToken": device["deviceToken"],
        "type": "publication_discovery_succeeded",
        "payload": {
            "found": True,
            "publicUrl": public_url,
            "publishedUrl": public_url,
            "platformStatus": "published",
            "publiclyVisible": True,
            "reviewStatus": "public",
        },
    }).json()

    assert completed["command"]["status"] == "succeeded"
    assert completed["mediaOrder"]["id"] == order["id"]
    assert completed["mediaOrder"]["status"] == "succeeded"
    assert completed["mediaOrder"]["backlinkUrl"] == public_url
    assert completed["mediaOrder"]["publicDiscoveryStatus"] == "found"
    assert completed["indexSubmission"] is None
    assert len(client.get("/api/media-orders").json()) == 1
    updated_article = client.get(f"/api/articles/{article['id']}").json()
    assert updated_article["publishedUrl"] == public_url
    assert updated_article["publicationStatus"] == "succeeded"
    assert updated_article["mediaPublishStatus"] == "succeeded"
    assert updated_article["mediaBacklinkStatus"] == "generated"
    assert updated_article["mediaPublishedUrl"] == public_url
    assert updated_article["mediaReviewUrl"] == public_url
    assert updated_article["mediaPublicDiscoveryStatus"] == "found"
    assert updated_article["indexStatus"] == "not_submitted"


def test_penguin_public_candidate_stays_in_review_until_anonymous_verification_succeeds():
    device, session, account = _create_active_image_recheck_account(
        "penguin",
        "https://om.qq.com/main/creation/article",
        "Penguin creator center",
    )
    article = client.post("/api/articles", json={
        "title": "Penguin candidate awaiting public visibility",
        "contentMarkdown": "This reviewed article has a real public candidate that is not anonymously visible yet.",
        "status": "ready",
    }).json()
    order = client.post("/api/media-orders", json={
        "articleId": article["id"],
        "articleTitle": article["title"],
        "accountId": account["id"],
        "platform": "penguin",
        "status": "review_required",
        "platformStatus": "submitted_for_review",
        "reviewStatus": "pending_public_visibility",
        "reviewUrl": "https://om.qq.com/s/article/20260721A08QY2",
        "publicDiscoveryStatus": "pending",
    }).json()
    command = client.post("/api/desktop-commands", json={
        "deviceId": device["device"]["id"],
        "type": "discover_publication",
        "mediaAccountId": account["id"],
        "payload": {
            "mediaOrderId": order["id"],
            "articleId": article["id"],
            "articleTitle": article["title"],
            "contentMarkdown": article["contentMarkdown"],
            "platform": "penguin",
            "sessionId": session["id"],
        },
    }).json()
    public_url = "https://page.om.qq.com/page/Oz1VIJyvyWEACK6tfAE-1GA0"

    completed = client.post(f"/api/desktop-commands/{command['id']}/events", json={
        "deviceId": device["device"]["id"],
        "deviceToken": device["deviceToken"],
        "type": "publication_discovery_succeeded",
        "payload": {
            "found": False,
            "publicUrl": public_url,
            "publishedUrl": public_url,
            "pageText": "内容被删除 这篇文章从地球上消失了",
            "platformStatus": "submitted_for_review",
            "publiclyVisible": False,
            "reviewStatus": "pending_public_visibility",
            "message": "公开候选页尚未通过匿名访问验证。",
        },
    }).json()

    assert completed["mediaOrder"]["id"] == order["id"]
    assert completed["mediaOrder"]["status"] == "review_required"
    assert completed["mediaOrder"]["reviewUrl"] == public_url
    assert completed["mediaOrder"]["backlinkUrl"] == ""
    assert completed["mediaOrder"]["publicDiscoveryStatus"] == "candidate_found"
    assert len(client.get("/api/media-orders").json()) == 1
    updated_article = client.get(f"/api/articles/{article['id']}").json()
    assert updated_article["publicationStatus"] == "review_required"
    assert updated_article["mediaPublishStatus"] == "review_required"
    assert updated_article["mediaBacklinkStatus"] == "reviewing"
    assert updated_article["mediaReviewUrl"] == public_url
    assert updated_article.get("mediaPublishedUrl", "") == ""
    assert updated_article["mediaPublicDiscoveryStatus"] == "candidate_found"

def test_penguin_publication_discovery_replaces_review_candidate_on_original_order():
    device, session, account = _create_active_image_recheck_account(
        "penguin",
        "https://om.qq.com/main/creation/article",
        "Penguin creator center",
    )
    article = client.post("/api/articles", json={
        "title": "Penguin reviewed public article",
        "contentMarkdown": "This body identifies the reviewed Penguin article and its public page.",
        "status": "ready",
    }).json()
    order = client.post("/api/media-orders", json={
        "articleId": article["id"],
        "articleTitle": article["title"],
        "accountId": account["id"],
        "platform": "penguin",
        "status": "review_required",
        "platformStatus": "submitted_for_review",
        "reviewStatus": "pending_public_visibility",
        "reviewUrl": "https://om.qq.com/s/article/20260721A08QY2",
        "publicDiscoveryStatus": "pending",
    }).json()
    command = client.post("/api/desktop-commands", json={
        "deviceId": device["device"]["id"],
        "type": "discover_publication",
        "mediaAccountId": account["id"],
        "payload": {
            "mediaOrderId": order["id"],
            "articleId": article["id"],
            "articleTitle": article["title"],
            "contentMarkdown": article["contentMarkdown"],
            "platform": "penguin",
            "sessionId": session["id"],
        },
    }).json()
    public_url = "https://page.om.qq.com/page/Oz1VIJyvyWEACK6tfAE-1GA0"

    completed = client.post(f"/api/desktop-commands/{command['id']}/events", json={
        "deviceId": device["device"]["id"],
        "deviceToken": device["deviceToken"],
        "type": "publication_discovery_succeeded",
        "payload": {
            "found": True,
            "publicUrl": public_url,
            "publishedUrl": public_url,
            "pageText": f"{article['title']} {article['contentMarkdown']}",
            "platformStatus": "published",
            "publiclyVisible": True,
            "reviewStatus": "public",
        },
    }).json()

    assert completed["mediaOrder"]["id"] == order["id"]
    assert completed["mediaOrder"]["status"] == "succeeded"
    assert completed["mediaOrder"]["reviewUrl"] == public_url
    assert completed["mediaOrder"]["backlinkUrl"] == public_url
    assert completed["mediaOrder"]["publicDiscoveryStatus"] == "found"
    assert len(client.get("/api/media-orders").json()) == 1
    updated_article = client.get(f"/api/articles/{article['id']}").json()
    assert updated_article["publishedUrl"] == public_url
    assert updated_article["publicationStatus"] == "succeeded"
    assert updated_article["mediaPublishStatus"] == "succeeded"
    assert updated_article["mediaBacklinkStatus"] == "generated"
    assert updated_article["mediaPublishedUrl"] == public_url
    assert updated_article["mediaReviewUrl"] == public_url
    assert updated_article["mediaPublicDiscoveryStatus"] == "found"


def test_toutiao_wrong_public_candidate_stays_unverified_without_backlink():
    device, session, account = _create_active_image_recheck_account(
        "toutiao",
        "https://mp.toutiao.com/profile_v4/graphic/publish",
        "Toutiao creator center",
    )
    article = client.post("/api/articles", json={
        "title": "Toutiao exact article title",
        "contentMarkdown": "This exact body belongs to the current Zhixin article.",
        "status": "ready",
    }).json()
    order = client.post("/api/media-orders", json={
        "articleId": article["id"],
        "articleTitle": article["title"],
        "accountId": account["id"],
        "platform": "toutiao",
        "status": "review_required",
        "platformStatus": "submitted_for_review",
        "reviewStatus": "pending_public_visibility",
        "publicDiscoveryStatus": "pending",
    }).json()
    command = client.post("/api/desktop-commands", json={
        "deviceId": device["device"]["id"],
        "type": "discover_publication",
        "mediaAccountId": account["id"],
        "payload": {
            "mediaOrderId": order["id"],
            "articleId": article["id"],
            "articleTitle": article["title"],
            "contentMarkdown": article["contentMarkdown"],
            "platform": "toutiao",
            "sessionId": session["id"],
        },
    }).json()
    wrong_url = "https://www.toutiao.com/item/7665015703212130866/"

    completed = client.post(f"/api/desktop-commands/{command['id']}/events", json={
        "deviceId": device["device"]["id"],
        "deviceToken": device["deviceToken"],
        "type": "publication_discovery_succeeded",
        "payload": {
            "found": True,
            "publicUrl": wrong_url,
            "publishedUrl": wrong_url,
            "pageText": "去哪些国家旅行可以让自己身心得到放松",
            "platformStatus": "published",
            "publiclyVisible": True,
            "reviewStatus": "public",
        },
    }).json()

    assert completed["command"]["result"]["verified"] is False
    assert completed["command"]["result"]["verificationReason"] == "PUBLIC_PAGE_NOT_MATCHED"
    assert completed["mediaOrder"]["status"] == "review_required"
    assert completed["mediaOrder"]["backlinkUrl"] == ""
    assert completed["mediaOrder"]["reviewUrl"] == wrong_url
    assert completed["mediaOrder"]["publicDiscoveryStatus"] == "pending"
    updated_article = client.get(f"/api/articles/{article['id']}").json()
    assert updated_article.get("mediaPublishedUrl", "") == ""
    assert updated_article.get("publishedUrl", "") == ""


def test_auto_publish_can_queue_without_generating_articles_in_request():
    result = client.post("/api/auto-publish", json={
        "name": "Queued batch",
        "selectedKeywords": ["AI SEO", "GEO visibility"],
        "ruleId": "rule-1",
        "ruleName": "Batch Rule",
    }).json()

    assert result["queued"] is True
    assert result["task"]["type"] == "auto-publish"
    assert result["task"]["queue"] == "publish"
    assert result["autoPublishTask"]["taskId"] == result["task"]["id"]
    assert result["autoPublishTask"]["status"] == "queued"
    assert result["autoPublishTask"]["generatedArticleIds"] == []
    stored_task = client.get("/api/auto-publish").json()[0]
    assert stored_task["taskId"] == result["task"]["id"]
    assert client.get("/api/articles").json() == []


def test_auto_publish_existing_article_uses_authorized_canonical_media_account():
    device = client.post("/api/desktop-devices/register", json={
        "deviceName": "Auto publish desktop",
        "platform": "windows",
        "appVersion": "0.2.0",
        "publicKey": "auto-publish-public-key",
    }).json()
    authorization = complete_media_authorization(
        device,
        platform="zhihu",
        account_name="Canonical Zhihu Publisher",
        fingerprint="auto-publish-canonical-account",
    )
    account = authorization["mediaAccount"]
    article = client.post("/api/articles", json={
        "title": "Existing article batch input",
        "keyword": "AI SEO",
        "status": "ready",
    }).json()

    result = client.post("/api/auto-publish", json={
        "name": "Publish existing article",
        "articleIds": [article["id"]],
        "mediaAccountIds": [account["id"]],
        "scheduleMode": "once",
        "confirmPublish": True,
    })

    assert result.status_code == 200
    payload = result.json()
    assert payload["autoPublishTask"]["publishCount"] == 1
    assert payload["autoPublishTask"]["articleIds"] == [article["id"]]
    assert payload["autoPublishTask"]["mediaAccountIds"] == [account["id"]]
    assert payload["task"]["payload"]["articleIds"] == [article["id"]]
    assert payload["task"]["payload"]["mediaAccountIds"] == [account["id"]]


def test_auto_publish_rejects_empty_inputs_and_unauthorized_publish_targets():
    empty = client.post("/api/auto-publish", json={"name": "Empty batch"})
    assert empty.status_code == 400
    assert empty.json()["detail"] == "AUTO_PUBLISH_INPUT_REQUIRED"

    article = client.post("/api/articles", json={
        "title": "Unauthorized media target",
        "keyword": "SEO",
        "status": "ready",
    }).json()
    unauthorized = client.post("/api/media-accounts", json={
        "platform": "zhihu",
        "name": "Expired Zhihu Account",
        "status": "needs_reauth",
        "credentialStatus": "needs_reauth",
    }).json()

    response = client.post("/api/auto-publish", json={
        "name": "Unauthorized batch",
        "articleIds": [article["id"]],
        "mediaAccountIds": [unauthorized["id"]],
        "scheduleMode": "once",
    })

    assert response.status_code == 400
    assert response.json()["detail"] == "MEDIA_ACCOUNT_NOT_AUTHORIZED"


def test_desktop_publish_result_updates_auto_publish_batch_progress():
    device = client.post("/api/desktop-devices/register", json={
        "deviceName": "Batch progress desktop",
        "platform": "windows",
        "appVersion": "0.2.0",
        "publicKey": "batch-progress-public-key",
    }).json()
    authorization = complete_media_authorization(
        device,
        platform="zhihu",
        account_name="Batch Progress Publisher",
        fingerprint="batch-progress-account",
    )
    account = authorization["mediaAccount"]
    article = client.post("/api/articles", json={
        "title": "Batch progress article",
        "keyword": "AI SEO",
        "contentMarkdown": "# Batch progress\n\nReal publishing result callback.",
        "status": "ready",
    }).json()
    with SessionLocal() as db:
        batch = save_record(db, "autoPublishTasks", {
            "id": "auto-publish-progress-1",
            "name": "Batch progress",
            "articleIds": [article["id"]],
            "mediaAccountIds": [account["id"]],
            "status": "publishing",
            "publishCount": 1,
            "successCount": 1,
            "failedCount": 0,
        })

    queued = client.post(f"/api/articles/{article['id']}/publish-from-context", json={
        "targetId": f"media:{account['id']}",
        "autoPublishTaskId": batch["id"],
        "confirmPublish": True,
        "submitIndex": True,
    }).json()
    completed = client.post(f"/api/desktop-commands/{queued['desktopCommand']['id']}/events", json={
        "deviceId": device["device"]["id"],
        "deviceToken": device["deviceToken"],
        "type": "publish_succeeded",
        "payload": {
            "publishedUrl": "https://zhuanlan.zhihu.com/p/auto-publish-progress-1",
            "platformStatus": "published",
            "publiclyVisible": True,
        },
    })

    assert completed.status_code == 200
    with SessionLocal() as db:
        updated = get_record(db, "autoPublishTasks", batch["id"])
    assert updated["status"] == "succeeded"
    assert updated["publishPendingCount"] == 0
    assert updated["publishSucceededCount"] == 1
    assert updated["publishFailedCount"] == 0


def test_auto_publish_rejects_request_thread_generation():
    response = client.post("/api/auto-publish", json={
        "name": "Synchronous batch",
        "selectedKeywords": ["AI SEO"],
        "async": False,
    })

    assert response.status_code == 400
    assert response.json()["detail"] == "AUTO_PUBLISH_REQUIRES_QUEUE"
    assert client.get("/api/articles").json() == []


def test_auto_geo_rewrite_batch_queues_ai_task_without_generating_in_request():
    first = client.post("/api/geo-analysis/collect", json={
        "keyword": "AI SEO",
        "question": "Which AI SEO system is recommended?",
        "platform": "DeepSeek",
        "sourceMedia": "example.com",
        "brandMention": False,
        "competitorMention": True,
        "answerExcerpt": "Competitors are cited.",
    }).json()["record"]
    client.post("/api/geo-analysis/collect", json={
        "keyword": "AI SEO",
        "question": "Already covered question",
        "platform": "ChatGPT",
        "brandMention": True,
    })

    result = client.post("/api/auto-geo/rewrite-batch", json={
        "limit": 3,
        "targetPlatforms": ["DeepSeek"],
        "ruleId": "rule-geo-1",
    }).json()

    assert result["queued"] is True
    assert result["task"]["type"] == "auto-geo-rewrite"
    assert result["task"]["queue"] == "ai"
    assert result["task"]["payload"]["questionIds"] == [first["id"]]
    assert result["autoGeoTask"]["status"] == "queued"
    assert result["autoGeoTask"]["generatedArticleIds"] == []
    assert client.get("/api/articles").json() == []


def test_media_account_list_returns_one_canonical_account_per_platform():
    with SessionLocal() as db:
        save_record(db, "mediaAccounts", {
            "id": "media-account-netease-old",
            "platform": "netease",
            "name": "Old Netease Account",
            "status": "needs_reauth",
            "credentialStatus": "needs_reauth",
            "lastVerifiedAt": "2026-07-12T07:00:00+00:00",
            "createdAt": "07/07 15:00",
            "updatedAt": "07/07 15:00",
        })
        save_record(db, "mediaAccounts", {
            "id": "media-account-netease-current",
            "platform": "netease",
            "name": "Current Netease Account",
            "status": "active",
            "credentialStatus": "active",
            "lastVerifiedAt": "2026-07-11T07:00:00+00:00",
            "createdAt": "07/11 15:00",
            "updatedAt": "07/11 15:00",
        })
        save_record(db, "mediaAccounts", {
            "id": "media-account-zhihu-current",
            "platform": "zhihu",
            "name": "Current Zhihu Account",
            "status": "active",
            "credentialStatus": "active",
            "lastVerifiedAt": "2026-07-10T07:00:00+00:00",
            "createdAt": "07/10 15:00",
            "updatedAt": "07/10 15:00",
        })

    visible = client.get("/api/media-accounts").json()
    by_platform = {account["platform"]: account for account in visible}

    assert len(visible) == 2
    assert by_platform["netease"]["id"] == "media-account-netease-current"
    assert by_platform["zhihu"]["id"] == "media-account-zhihu-current"
    assert len(client.get("/api/media-accounts?includeSuperseded=true").json()) == 3

    with SessionLocal() as db:
        migration = supersede_duplicate_media_accounts(db)
        old_account = get_record(db, "mediaAccounts", "media-account-netease-old")
        current_account = get_record(db, "mediaAccounts", "media-account-netease-current")

    assert migration == {"platforms": 2, "superseded": 1}
    assert old_account["status"] == "superseded"
    assert old_account["supersededByAccountId"] == current_account["id"]
    assert current_account["isCanonical"] is True
    assert len(client.get("/api/media-accounts?includeSuperseded=true").json()) == 3


def test_media_account_slot_is_scoped_per_owner():
    # The startup sweep runs without an actor, so it sees every owner's
    # accounts. A platform identity must stay per owner or one owner's login
    # revokes another owner's orders.
    with actor_scope(None), SessionLocal() as db:
        for owner_id, account_id in (
            ("owner-alpha", "media-account-netease-alpha"),
            ("owner-beta", "media-account-netease-beta"),
        ):
            verified_at = "2026-10-18T05:00:00+00:00"
            save_record(db, "mediaAccounts", {
                "id": account_id,
                "ownerId": owner_id,
                "platform": "netease",
                "name": f"{owner_id} netease account",
                "status": "active",
                "credentialStatus": "active",
                "isCanonical": True,
                "lastVerifiedAt": verified_at,
                "createdAt": verified_at,
                "updatedAt": verified_at,
            })

    with actor_scope(None), SessionLocal() as db:
        migration = supersede_duplicate_media_accounts(db)
        alpha = get_record(db, "mediaAccounts", "media-account-netease-alpha")
        beta = get_record(db, "mediaAccounts", "media-account-netease-beta")

    assert migration == {"platforms": 2, "superseded": 0}
    for account in (alpha, beta):
        assert account["status"] == "active"
        assert account["credentialStatus"] == "active"
        assert account["isCanonical"] is True
        assert account.get("supersededByAccountId", "") == ""
        assert account.get("supersededAt", "") == ""


def test_reauthorizing_platform_reuses_account_and_replaces_login_state():
    device = client.post("/api/desktop-devices/register", json={
        "deviceName": "Canonical Account Desktop",
        "platform": "windows",
        "appVersion": "0.2.0",
        "publicKey": "canonical-account-public-key",
    }).json()

    first = complete_media_authorization(
        device,
        platform="zhihu",
        account_name="First Zhihu Login",
        fingerprint="fingerprint-first",
    )
    second = complete_media_authorization(
        device,
        platform="zhihu",
        account_name="Replacement Zhihu Login",
        fingerprint="fingerprint-second",
    )

    assert second["mediaAccount"]["id"] == first["mediaAccount"]["id"]
    assert second["mediaAccount"]["name"] == "Replacement Zhihu Login"
    assert second["mediaAccount"]["authArtifactId"] == second["artifact"]["id"]
    assert client.get("/api/media-accounts").json() == [second["mediaAccount"]]

    with SessionLocal() as db:
        first_artifact = get_record(db, "mediaAuthArtifacts", first["artifact"]["id"])
        bindings = [
            binding for binding in list_records(db, "mediaAccountBindings")
            if binding.get("mediaAccountId") == first["mediaAccount"]["id"]
        ]

    assert first_artifact["status"] == "superseded"
    assert first_artifact["supersededBy"] == second["artifact"]["id"]
    assert len([binding for binding in bindings if binding.get("status") == "active"]) == 1
    assert next(binding for binding in bindings if binding.get("status") == "active")["artifactId"] == second["artifact"]["id"]


def test_reauthorization_supersedes_legacy_duplicates_without_deleting_history():
    with SessionLocal() as db:
        save_record(db, "mediaAccounts", {
            "id": "media-account-zhihu-old",
            "platform": "zhihu",
            "name": "Old Zhihu Login",
            "status": "needs_reauth",
            "credentialStatus": "needs_reauth",
            "lastVerifiedAt": "2026-07-01T07:00:00+00:00",
            "createdAt": "07/01 15:00",
            "updatedAt": "07/01 15:00",
        })
        save_record(db, "mediaAccounts", {
            "id": "media-account-zhihu-current",
            "platform": "zhihu",
            "name": "Current Zhihu Login",
            "status": "needs_reauth",
            "credentialStatus": "needs_reauth",
            "lastVerifiedAt": "2026-07-10T07:00:00+00:00",
            "createdAt": "07/10 15:00",
            "updatedAt": "07/10 15:00",
        })
        save_record(db, "mediaAccounts", {
            "id": "media-account-csdn-current",
            "platform": "csdn",
            "name": "CSDN Login",
            "status": "active",
            "credentialStatus": "active",
            "lastVerifiedAt": "2026-07-09T07:00:00+00:00",
            "createdAt": "07/09 15:00",
            "updatedAt": "07/09 15:00",
        })

    device = client.post("/api/desktop-devices/register", json={
        "deviceName": "Legacy Account Desktop",
        "platform": "windows",
        "appVersion": "0.2.0",
        "publicKey": "legacy-account-public-key",
    }).json()
    replacement = complete_media_authorization(
        device,
        platform="zhihu",
        account_name="Replacement Zhihu Login",
        fingerprint="fingerprint-replacement",
    )

    assert replacement["mediaAccount"]["id"] == "media-account-zhihu-current"
    with SessionLocal() as db:
        old_account = get_record(db, "mediaAccounts", "media-account-zhihu-old")
        current_account = get_record(db, "mediaAccounts", "media-account-zhihu-current")
        csdn_account = get_record(db, "mediaAccounts", "media-account-csdn-current")
        all_accounts = list_records(db, "mediaAccounts")

    assert len(all_accounts) == 3
    assert old_account["status"] == "superseded"
    assert old_account["supersededByAccountId"] == current_account["id"]
    assert current_account["status"] == "active"
    assert current_account["authArtifactId"] == replacement["artifact"]["id"]
    assert csdn_account["status"] == "active"
    assert {account["platform"] for account in client.get("/api/media-accounts").json()} == {"zhihu", "csdn"}


def test_superseded_media_account_id_routes_publish_to_canonical_account():
    device = client.post("/api/desktop-devices/register", json={
        "deviceName": "Superseded Account Desktop",
        "platform": "windows",
        "appVersion": "0.2.0",
        "publicKey": "superseded-account-public-key",
    }).json()
    authorization = complete_media_authorization(
        device,
        platform="zhihu",
        account_name="Canonical Zhihu Login",
        fingerprint="fingerprint-canonical",
    )
    canonical_id = authorization["mediaAccount"]["id"]
    with SessionLocal() as db:
        save_record(db, "mediaAccounts", {
            "id": "media-account-zhihu-superseded",
            "platform": "zhihu",
            "name": "Superseded Zhihu Login",
            "status": "superseded",
            "credentialStatus": "revoked",
            "supersededByAccountId": canonical_id,
            "createdAt": "07/01 15:00",
            "updatedAt": "07/11 15:00",
        })
    article = client.post("/api/articles", json={
        "title": "Canonical account publish routing",
        "keyword": "SEO",
        "status": "ready",
    }).json()

    response = client.post(f"/api/articles/{article['id']}/publish-from-context", json={
        "targetId": "media:media-account-zhihu-superseded",
        "provider": "IndexNow",
        "confirmPublish": True,
    })

    assert response.status_code == 200
    result = response.json()
    assert result["desktopCommand"]["mediaAccountId"] == canonical_id
    assert result["targetId"] == canonical_id


def test_desktop_media_authorization_protocol_closes_account_binding_and_publish_command():
    device = client.post("/api/desktop-devices/register", json={
        "deviceName": "Windows Workstation",
        "platform": "windows",
        "appVersion": "0.1.0",
        "publicKey": "desktop-public-key",
    }).json()

    assert device["device"]["status"] == "active"
    assert device["deviceToken"]

    created = client.post("/api/media-auth-sessions", json={
        "platform": "zhihu",
        "deviceId": device["device"]["id"],
    }).json()
    session = created["session"]

    assert session["status"] == "waiting_desktop"
    assert session["pairingCode"]
    assert created["desktopLaunchUrl"].startswith("zhixin-ai://media-auth/")

    claimed = client.post(
        f"/api/desktop-devices/{device['device']['id']}/media-auth-sessions/{session['id']}/claim",
        json={"pairingCode": session["pairingCode"], "deviceToken": device["deviceToken"]},
    ).json()
    assert claimed["session"]["status"] == "desktop_ready"

    opened = client.post(
        "/api/desktop-events",
        headers={
            "x-device-id": device["device"]["id"],
            "x-device-token": device["deviceToken"],
        },
        json={
            "deviceId": device["device"]["id"],
            "sessionId": session["id"],
            "type": "browser_opened",
            "payload": {"url": "https://www.zhihu.com/signin"},
        },
    ).json()
    assert opened["session"]["status"] == "login_opened"

    submitted = client.post(f"/api/media-auth-sessions/{session['id']}/artifacts", json={
        "deviceId": device["device"]["id"],
        "accountName": "SEO 增长笔记",
        "artifact": {
            "cookies": "encrypted-cookie-payload",
            "localStorage": "encrypted-local-storage",
            "sessionStorage": "encrypted-session-storage",
            "fingerprint": "sha256-demo-fingerprint",
            "authorizationEvidence": {
                "strongCookiePresent": True,
                "workspaceReady": True,
                "currentUrl": "https://www.zhihu.com/creator",
                "pageTitle": "Zhihu creator center",
            },
        },
    }).json()
    assert submitted["session"]["status"] == "verified"
    assert "encryptedCookies" not in submitted["artifact"]
    assert "encryptedLocalStorage" not in submitted["artifact"]
    assert "encryptedSessionStorage" not in submitted["artifact"]
    assert "cookies" not in submitted["artifact"]

    bound = client.post(f"/api/media-auth-sessions/{session['id']}/bind", json={"name": "知乎账号"}).json()
    account = bound["mediaAccount"]

    assert bound["session"]["status"] == "bound"
    assert account["status"] == "active"
    assert account["authArtifactId"] == submitted["artifact"]["id"]
    assert account["credentialFingerprint"] == "sha256-demo-fingerprint"
    assert account["cookies"] == ""

    command = client.post("/api/desktop-commands", json={
        "deviceId": device["device"]["id"],
        "type": "publish_article",
        "mediaAccountId": account["id"],
        "payload": {"articleTitle": "桌面端授权发布测试"},
    }).json()
    assert command["status"] == "queued"

    completed = client.post(f"/api/desktop-commands/{command['id']}/events", json={
        "deviceId": device["device"]["id"],
        "deviceToken": device["deviceToken"],
        "type": "publish_succeeded",
        "payload": {"publishedUrl": "https://www.zhihu.com/p/123"},
    }).json()
    assert completed["command"]["status"] == "succeeded"
    assert completed["command"]["result"]["publishedUrl"] == "https://www.zhihu.com/p/123"


def test_device_authenticated_artifact_rotation_and_public_redaction():
    device = client.post("/api/desktop-devices/register", json={
        "deviceName": "Primary Desktop",
        "platform": "windows",
        "appVersion": "0.2.0",
        "publicKey": "desktop-public-key",
    }).json()
    other_device = client.post("/api/desktop-devices/register", json={
        "deviceName": "Other Desktop",
        "platform": "windows",
        "appVersion": "0.2.0",
        "publicKey": "other-public-key",
    }).json()
    created = client.post("/api/media-auth-sessions", json={
        "platform": "zhihu",
        "deviceId": device["device"]["id"],
    }).json()
    session = created["session"]
    client.post(
        f"/api/desktop-devices/{device['device']['id']}/media-auth-sessions/{session['id']}/claim",
        json={"pairingCode": session["pairingCode"], "deviceToken": device["deviceToken"]},
    )
    submitted = client.post(f"/api/media-auth-sessions/{session['id']}/artifacts", json={
        "deviceId": device["device"]["id"],
        "accountName": "Persistent Zhihu Account",
        "artifact": {
            "cookies": "encrypted-cookie-v1",
            "localStorage": "encrypted-local-storage-v1",
            "sessionStorage": "encrypted-session-storage-v1",
            "fingerprint": "fingerprint-v1",
            "authorizationEvidence": {
                "strongCookiePresent": True,
                "workspaceReady": True,
                "currentUrl": "https://www.zhihu.com/creator",
                "pageTitle": "Zhihu creator center",
            },
        },
    }).json()
    bound = client.post(
        f"/api/media-auth-sessions/{session['id']}/bind",
        json={"name": "Persistent Zhihu Account"},
    ).json()
    account = bound["mediaAccount"]

    assert account["profileKey"] == session["id"]
    public_detail = client.get(f"/api/media-auth-sessions/{session['id']}").json()
    assert "encryptedCookies" not in public_detail["artifact"]
    assert "encryptedLocalStorage" not in public_detail["artifact"]
    assert "encryptedSessionStorage" not in public_detail["artifact"]

    wrong_token = client.post(
        f"/api/desktop-devices/{device['device']['id']}/media-accounts/{account['id']}/artifact",
        json={"deviceToken": "wrong-token"},
    )
    assert wrong_token.status_code == 403
    wrong_device = client.post(
        f"/api/desktop-devices/{other_device['device']['id']}/media-accounts/{account['id']}/artifact",
        json={"deviceToken": other_device["deviceToken"]},
    )
    assert wrong_device.status_code == 403

    full = client.post(
        f"/api/desktop-devices/{device['device']['id']}/media-accounts/{account['id']}/artifact",
        json={"deviceToken": device["deviceToken"]},
    ).json()
    assert full["artifact"]["encryptedCookies"] == "encrypted-cookie-v1"
    assert full["artifact"]["encryptedLocalStorage"] == "encrypted-local-storage-v1"
    assert full["artifact"]["encryptedSessionStorage"] == "encrypted-session-storage-v1"
    assert full["profileKey"] == session["id"]

    refreshed = client.post(
        f"/api/desktop-devices/{device['device']['id']}/media-accounts/{account['id']}/artifacts/refresh",
        json={
            "deviceToken": device["deviceToken"],
            "profileKey": session["id"],
            "artifact": {
                "cookies": "encrypted-cookie-v2",
                "localStorage": "encrypted-local-storage-v2",
                "sessionStorage": "encrypted-session-storage-v2",
                "fingerprint": "fingerprint-v2",
                "credentialMetadata": {
                    "credentialExpiresAt": "2026-12-31T00:00:00.000Z",
                    "hasSessionCredentials": False,
                    "strongCookieCount": 1,
                },
                "authorizationEvidence": {
                    "strongCookiePresent": True,
                    "workspaceReady": True,
                    "currentUrl": "https://www.zhihu.com/creator",
                    "pageTitle": "Zhihu creator center",
                },
            },
        },
    ).json()

    assert refreshed["artifact"]["id"] != submitted["artifact"]["id"]
    assert refreshed["supersededArtifactId"] == submitted["artifact"]["id"]
    assert refreshed["mediaAccount"]["authArtifactId"] == refreshed["artifact"]["id"]
    assert refreshed["mediaAccount"]["credentialFingerprint"] == "fingerprint-v2"
    assert refreshed["mediaAccount"]["credentialStatus"] == "active"
    assert refreshed["mediaAccount"]["credentialExpiresAt"] == "2026-12-31T00:00:00.000Z"
    assert refreshed["mediaAccount"]["consecutiveAuthFailures"] == 0
    assert refreshed["mediaAccount"]["lastVerifiedAt"]
    assert refreshed["mediaAccount"]["nextCredentialCheckAt"]


def test_artifact_refresh_keeps_editor_token_evidence_when_the_capture_lost_it():
    device = client.post("/api/desktop-devices/register", json={
        "deviceName": "Windows Workstation",
        "platform": "windows",
        "appVersion": "0.1.0",
        "publicKey": "desktop-public-key",
    }).json()
    created = client.post("/api/media-auth-sessions", json={
        "platform": "baijiahao",
        "deviceId": device["device"]["id"],
    }).json()
    session = created["session"]
    client.post(
        f"/api/desktop-devices/{device['device']['id']}/media-auth-sessions/{session['id']}/claim",
        json={"pairingCode": session["pairingCode"], "deviceToken": device["deviceToken"]},
    )
    client.post(f"/api/media-auth-sessions/{session['id']}/artifacts", json={
        "deviceId": device["device"]["id"],
        "accountName": "Baijiahao Account",
        "artifact": {
            "cookies": "encrypted-cookie-v1",
            "localStorage": "encrypted-local-storage-v1",
            "sessionStorage": "encrypted-session-storage-v1",
            "fingerprint": "fingerprint-v1",
            "authorizationEvidence": {
                "strongCookiePresent": True,
                "workspaceReady": True,
                "currentUrl": "https://baijiahao.baidu.com/builder/rc/edit",
                "pageTitle": "百家号创作中心",
            },
        },
    })
    account = client.post(
        f"/api/media-auth-sessions/{session['id']}/bind",
        json={"name": "Baijiahao Account"},
    ).json()["mediaAccount"]

    def refresh(metadata: dict) -> dict:
        return client.post(
            f"/api/desktop-devices/{device['device']['id']}/media-accounts/{account['id']}/artifacts/refresh",
            json={
                "deviceToken": device["deviceToken"],
                "profileKey": account["profileKey"],
                "artifact": {
                    "cookies": "encrypted-cookie-rotated",
                    "localStorage": "encrypted-local-storage-rotated",
                    "sessionStorage": "encrypted-session-storage-v1",
                    "fingerprint": "fingerprint-rotated",
                    "credentialMetadata": metadata,
                    "authorizationEvidence": {
                        "strongCookiePresent": True,
                        "workspaceReady": True,
                        "currentUrl": "https://baijiahao.baidu.com/builder/rc/edit",
                        "pageTitle": "百家号创作中心",
                    },
                },
            },
        ).json()

    editor_expires_at = "2099-01-01T00:00:00.000Z"
    cookie_only_expires_at = "2099-06-01T00:00:00.000Z"

    first = refresh({
        "credentialExpiresAt": editor_expires_at,
        "editorTokenExpiresAt": editor_expires_at,
        "editorTokenTtlSeconds": 43200,
    })
    assert first["mediaAccount"]["credentialExpiresAt"] == editor_expires_at
    assert first["artifact"]["credentialMetadata"]["editorTokenTtlSeconds"] == 43200

    # The editor cleaned the expired edit-token from storage, so the fresh capture only
    # carries cookie expiry months later. Adopting it would hide the real publishing
    # deadline, so the refresh keeps the editor-token evidence recorded last time.
    second = refresh({"credentialExpiresAt": cookie_only_expires_at})
    assert second["mediaAccount"]["credentialExpiresAt"] == editor_expires_at
    assert second["mediaAccount"]["credentialStatus"] == "active"
    assert second["artifact"]["credentialMetadata"]["editorTokenExpiresAt"] == editor_expires_at
    assert second["artifact"]["credentialMetadata"]["editorTokenTtlSeconds"] == 43200

    # A genuinely fresh editor token still replaces the stored evidence.
    fresh_expires_at = "2099-01-02T00:00:00.000Z"
    third = refresh({
        "credentialExpiresAt": fresh_expires_at,
        "editorTokenExpiresAt": fresh_expires_at,
        "editorTokenTtlSeconds": 43200,
    })
    assert third["mediaAccount"]["credentialExpiresAt"] == fresh_expires_at
    assert third["artifact"]["credentialMetadata"]["editorTokenExpiresAt"] == fresh_expires_at


def test_media_auth_artifact_requires_strong_cookie_and_workspace_evidence():
    device = client.post("/api/desktop-devices/register", json={
        "deviceName": "Windows Workstation",
        "platform": "windows",
        "appVersion": "0.1.0",
        "publicKey": "desktop-public-key",
    }).json()
    created = client.post("/api/media-auth-sessions", json={
        "platform": "sohu",
        "deviceId": device["device"]["id"],
    }).json()
    session = created["session"]
    client.post(
        f"/api/desktop-devices/{device['device']['id']}/media-auth-sessions/{session['id']}/claim",
        json={"pairingCode": session["pairingCode"], "deviceToken": device["deviceToken"]},
    )

    response = client.post(f"/api/media-auth-sessions/{session['id']}/artifacts", json={
        "deviceId": device["device"]["id"],
        "accountName": "Sohu account",
        "artifact": {
            "cookies": "encrypted-cookie-payload",
            "localStorage": "encrypted-local-storage",
            "sessionStorage": "encrypted-session-storage",
            "fingerprint": "sha256-demo-fingerprint",
            "authorizationEvidence": {
                "strongCookiePresent": True,
                "workspaceReady": False,
                "currentUrl": "https://mp.sohu.com/mpfe/v4/login",
                "pageTitle": "Sohu login",
            },
        },
    })

    assert response.status_code == 400
    assert response.json()["detail"] == "AUTHORIZATION_EVIDENCE_REQUIRED"


def test_netease_media_auth_requires_real_mp_workspace_evidence():
    device = client.post("/api/desktop-devices/register", json={
        "deviceName": "Windows Workstation",
        "platform": "windows",
        "appVersion": "0.1.0",
        "publicKey": "desktop-public-key",
    }).json()
    created = client.post("/api/media-auth-sessions", json={
        "platform": "netease",
        "deviceId": device["device"]["id"],
    }).json()
    session = created["session"]
    client.post(
        f"/api/desktop-devices/{device['device']['id']}/media-auth-sessions/{session['id']}/claim",
        json={"pairingCode": session["pairingCode"], "deviceToken": device["deviceToken"]},
    )

    response = client.post(f"/api/media-auth-sessions/{session['id']}/artifacts", json={
        "deviceId": device["device"]["id"],
        "accountName": "Netease account",
        "artifact": {
            "cookies": "encrypted-cookie-payload",
            "localStorage": "encrypted-local-storage",
            "sessionStorage": "encrypted-session-storage",
            "fingerprint": "sha256-demo-fingerprint",
            "authorizationEvidence": {
                "strongCookiePresent": True,
                "workspaceReady": True,
                "currentUrl": "https://mp.163.com/login.html?url=https%3A%2F%2Fmp.163.com%2F#/",
                "pageTitle": "网易号",
                "pageText": "登录 / 注册 创作指南 运营指南",
            },
        },
    })

    assert response.status_code == 400
    assert response.json()["detail"] == "AUTHORIZATION_EVIDENCE_REQUIRED"


def test_publish_command_requires_active_verified_media_credentials():
    account = client.post("/api/media-accounts", json={
        "name": "Legacy media account",
        "platform": "sohu",
        "status": "active",
        "authArtifactId": "legacy-artifact-id",
        "credentialStatus": "invalid",
    }).json()

    response = client.post("/api/desktop-commands", json={
        "type": "publish_article",
        "mediaAccountId": account["id"],
        "payload": {"articleTitle": "Should not publish"},
    })

    assert response.status_code == 400
    assert response.json()["detail"] == "MEDIA_ACCOUNT_NOT_AUTHORIZED"


def test_can_read_single_media_account_for_desktop_publish_routing():
    account = client.post("/api/media-accounts", json={
        "name": "Sohu account",
        "platform": "sohu",
        "status": "active",
        "credentialStatus": "active",
    }).json()

    response = client.get(f"/api/media-accounts/{account['id']}")

    assert response.status_code == 200
    assert response.json()["id"] == account["id"]
    assert response.json()["platform"] == "sohu"


def test_desktop_publish_command_records_manual_verification_state():
    device = client.post("/api/desktop-devices/register", json={
        "deviceName": "Windows Workstation",
        "platform": "windows",
        "appVersion": "0.1.0",
        "publicKey": "desktop-public-key",
    }).json()
    session = client.post("/api/media-auth-sessions", json={
        "platform": "baijiahao",
        "deviceId": device["device"]["id"],
    }).json()["session"]
    client.post(
        f"/api/desktop-devices/{device['device']['id']}/media-auth-sessions/{session['id']}/claim",
        json={"pairingCode": session["pairingCode"], "deviceToken": device["deviceToken"]},
    )
    artifact = client.post(f"/api/media-auth-sessions/{session['id']}/artifacts", json={
        "deviceId": device["device"]["id"],
        "accountName": "Baijiahao account",
        "artifact": {
            "cookies": "encrypted-cookie-payload",
            "localStorage": "encrypted-local-storage",
            "sessionStorage": "encrypted-session-storage",
            "fingerprint": "sha256-demo-fingerprint",
            "authorizationEvidence": {
                "strongCookiePresent": True,
                "workspaceReady": True,
                "currentUrl": "https://baijiahao.baidu.com/builder/rc/home",
                "pageTitle": "Baijiahao creator center",
            },
        },
    }).json()
    account = client.post(f"/api/media-auth-sessions/{session['id']}/bind", json={"name": "Baijiahao account"}).json()["mediaAccount"]

    command = client.post("/api/desktop-commands", json={
        "type": "publish_article",
        "mediaAccountId": account["id"],
        "payload": {"articleTitle": "Baijiahao verification"},
    }).json()
    assert command["deviceId"] == device["device"]["id"]

    updated = client.post(f"/api/desktop-commands/{command['id']}/events", json={
        "deviceId": device["device"]["id"],
        "deviceToken": device["deviceToken"],
        "type": "manual_verification_required",
        "payload": {
            "platform": "baijiahao",
            "message": "请在弹出的百家号窗口完成百度安全验证，验证通过后会继续发布。",
            "currentUrl": "https://baijiahao.baidu.com/builder/rc/edit?type=news",
        },
    }).json()

    assert updated["command"]["status"] == "running"
    assert updated["command"]["result"]["platformStatus"] == "manual_verification_required"
    assert updated["command"]["result"]["message"] == "请在弹出的百家号窗口完成百度安全验证，验证通过后会继续发布。"


def test_desktop_publish_login_required_marks_media_account_needs_reauth():
    device = client.post("/api/desktop-devices/register", json={
        "deviceName": "Windows Workstation",
        "platform": "windows",
        "appVersion": "0.1.0",
        "publicKey": "desktop-public-key",
    }).json()
    session = client.post("/api/media-auth-sessions", json={
        "platform": "penguin",
        "deviceId": device["device"]["id"],
    }).json()["session"]
    client.post(
        f"/api/desktop-devices/{device['device']['id']}/media-auth-sessions/{session['id']}/claim",
        json={"pairingCode": session["pairingCode"], "deviceToken": device["deviceToken"]},
    )
    client.post(f"/api/media-auth-sessions/{session['id']}/artifacts", json={
        "deviceId": device["device"]["id"],
        "accountName": "Penguin account",
        "artifact": {
            "cookies": "encrypted-cookie-payload",
            "localStorage": "encrypted-local-storage",
            "sessionStorage": "encrypted-session-storage",
            "fingerprint": "sha256-penguin-reauth-fingerprint",
            "authorizationEvidence": {
                "strongCookiePresent": True,
                "workspaceReady": True,
                "currentUrl": "https://om.qq.com/main",
                "pageTitle": "Penguin creator center",
            },
        },
    })
    account = client.post(f"/api/media-auth-sessions/{session['id']}/bind", json={"name": "Penguin account"}).json()["mediaAccount"]

    command = client.post("/api/desktop-commands", json={
        "type": "publish_article",
        "mediaAccountId": account["id"],
        "payload": {"articleTitle": "Penguin auth expired", "platform": "penguin"},
    }).json()

    updated = client.post(f"/api/desktop-commands/{command['id']}/events", json={
        "deviceId": device["device"]["id"],
        "deviceToken": device["deviceToken"],
        "type": "publish_failed",
        "payload": {"errorMessage": "PENGUIN_LOGIN_REQUIRED"},
    }).json()
    refreshed = client.get(f"/api/media-accounts/{account['id']}").json()

    assert updated["command"]["status"] == "failed"
    assert refreshed["status"] == "needs_reauth"
    assert refreshed["credentialStatus"] == "needs_reauth"
    assert refreshed["lastError"] == "PENGUIN_LOGIN_REQUIRED"


def test_media_auth_session_can_queue_desktop_open_auth_command():
    device = client.post("/api/desktop-devices/register", json={
        "deviceName": "Windows Workstation",
        "platform": "windows",
        "appVersion": "0.1.0",
        "publicKey": "desktop-public-key",
    }).json()

    created = client.post("/api/media-auth-sessions", json={
        "platform": "zhihu",
        "deviceId": device["device"]["id"],
        "queueDesktopCommand": True,
        "keepBrowserOpen": True,
        "waitLoginMs": 300000,
    }).json()

    session = created["session"]
    command = created["desktopCommand"]

    assert session["status"] == "waiting_desktop"
    assert command["type"] == "open_auth"
    assert command["status"] == "queued"
    assert command["deviceId"] == device["device"]["id"]
    assert command["payload"]["sessionId"] == session["id"]
    assert command["payload"]["pairingCode"] == session["pairingCode"]
    assert command["payload"]["platform"] == "zhihu"
    assert command["payload"]["keepBrowserOpen"] is True
    assert command["payload"]["waitLoginMs"] == 300000

def test_extra_free_media_platforms_use_real_login_urls_and_fields():
    expected = {
        "csdn": ("https://mp.csdn.net/", ["标题", "正文", "分类", "标签", "封面"]),
        "netease": ("https://mp.163.com/", ["标题", "正文", "分类", "封面"]),
        "penguin": ("https://om.qq.com/", ["标题", "正文", "分类", "封面", "原创声明"]),
        "toutiao": ("https://mp.toutiao.com/profile_v4/", ["标题", "正文", "分类", "封面", "原创声明"]),
        "jianshu": ("https://www.jianshu.com/sign_in", ["标题", "正文", "文集", "标签"]),
    }
    device = client.post("/api/desktop-devices/register", json={
        "deviceName": "Windows Workstation",
        "platform": "windows",
        "appVersion": "0.1.0",
        "publicKey": "desktop-public-key",
    }).json()

    for platform, (login_url, fields) in expected.items():
        created = client.post("/api/media-auth-sessions", json={
            "platform": platform,
            "deviceId": device["device"]["id"],
            "queueDesktopCommand": True,
        }).json()
        session = created["session"]
        command = created["desktopCommand"]

        assert session["loginUrl"] == login_url
        assert command["payload"]["platform"] == platform
        assert command["payload"]["loginUrl"] == login_url

        client.post(
            f"/api/desktop-devices/{device['device']['id']}/media-auth-sessions/{session['id']}/claim",
            json={"pairingCode": session["pairingCode"], "deviceToken": device["deviceToken"]},
        )
        client.post(f"/api/media-auth-sessions/{session['id']}/artifacts", json={
            "deviceId": device["device"]["id"],
            "accountName": f"{platform}增长号",
            "artifact": {
                "cookies": f"encrypted-cookie-{platform}",
                "localStorage": "encrypted-local-storage",
                "sessionStorage": "encrypted-session-storage",
                "fingerprint": f"fp-{platform}-test",
                "storageVersion": 2,
                "authorizationEvidence": {
                    "strongCookiePresent": True,
                    "workspaceReady": True,
                    "currentUrl": "https://mp.163.com/#/article/manage" if platform == "netease" else login_url,
                    "pageTitle": "网易号创作中心" if platform == "netease" else "creator center",
                    "pageText": "创作中心 内容管理 发布 写文章" if platform == "netease" else "creator center",
                },
            },
        })
        bound = client.post(f"/api/media-auth-sessions/{session['id']}/bind", json={"name": f"{platform}增长号"}).json()

        assert bound["mediaAccount"]["platform"] == platform
        assert bound["mediaAccount"]["fields"] == fields


def test_media_account_session_validation_queues_once_for_the_bound_device():
    device, _session, account = create_active_netease_account_for_publication_discovery()

    first = client.post(f"/api/media-accounts/{account['id']}/validate-session")
    assert first.status_code == 200
    first_body = first.json()
    assert first_body["queued"] is True
    assert first_body["deduplicated"] is False
    assert first_body["desktopCommand"]["type"] == "validate_session"
    assert first_body["desktopCommand"]["deviceId"] == device["device"]["id"]
    assert first_body["desktopCommand"]["mediaAccountId"] == account["id"]

    second_body = client.post(f"/api/media-accounts/{account['id']}/validate-session").json()
    assert second_body["deduplicated"] is True
    assert second_body["desktopCommand"]["id"] == first_body["desktopCommand"]["id"]


def _register_labelled_device(device_name: str, owner_id: str, last_seen_at: str = "") -> dict:
    device = client.post("/api/desktop-devices/register", json={
        "deviceName": device_name,
        "platform": "windows",
        "appVersion": "0.1.0",
        "publicKey": "desktop-public-key",
    }).json()
    with SessionLocal() as db:
        row = db.get(Record, device["device"]["id"])
        assert row is not None
        row.data = {
            **row.data,
            "boundOwnerId": owner_id,
            **({"lastSeenAt": last_seen_at} if last_seen_at else {}),
        }
        db.commit()
    return device


def _patch_device(device_id: str, owner_id: str, last_seen_at: str = "") -> None:
    with SessionLocal() as db:
        row = db.get(Record, device_id)
        assert row is not None
        row.data = {
            **row.data,
            "boundOwnerId": owner_id,
            **({"lastSeenAt": last_seen_at} if last_seen_at else {}),
        }
        db.commit()


def test_session_validation_reroutes_to_live_device_and_skips_zombie_commands():
    owner_id = "test-owner"
    stranded = _register_labelled_device("Stranded Desktop", owner_id)
    account = complete_media_authorization(
        stranded,
        platform="zhihu",
        account_name="知乎搁浅账号",
        fingerprint="zhihu-stranded",
    )["mediaAccount"]
    _patch_device(stranded["device"]["id"], owner_id, "01/01 00:00")
    live = _register_labelled_device("Current Desktop", owner_id)

    with SessionLocal() as db:
        save_record(db, "desktopCommands", {
            "id": "desktop-command-zombie-validate",
            "deviceId": stranded["device"]["id"],
            "type": "validate_session",
            "mediaAccountId": account["id"],
            "payload": {},
            "status": "queued",
            "result": {},
            "errorMessage": "",
            "createdAt": "01/01 00:00",
            "updatedAt": "01/01 00:00",
        })

    body = client.post(f"/api/media-accounts/{account['id']}/validate-session").json()
    assert body["deduplicated"] is False
    assert body["desktopCommand"]["id"] != "desktop-command-zombie-validate"
    assert body["desktopCommand"]["deviceId"] == live["device"]["id"]

    with SessionLocal() as db:
        bindings = [
            item for item in list_records(db, "mediaAccountBindings")
            if item.get("mediaAccountId") == account["id"] and item.get("status") == "active"
        ]
    assert bindings[-1]["deviceId"] == live["device"]["id"]

    repeat = client.post(f"/api/media-accounts/{account['id']}/validate-session").json()
    assert repeat["deduplicated"] is True
    assert repeat["desktopCommand"]["id"] == body["desktopCommand"]["id"]


def test_live_device_adopts_binding_stranded_on_dead_device_for_artifact_fetch():
    owner_id = "test-owner"
    stranded = _register_labelled_device("Stranded Artifact Desktop", owner_id)
    account = complete_media_authorization(
        stranded,
        platform="zhihu",
        account_name="知乎 artifacts 搁浅账号",
        fingerprint="zhihu-stranded-artifact",
    )["mediaAccount"]
    _patch_device(stranded["device"]["id"], owner_id, "01/01 00:00")
    live = _register_labelled_device("Current Artifact Desktop", owner_id)

    adopted = client.post(
        f"/api/desktop-devices/{live['device']['id']}/media-accounts/{account['id']}/artifact",
        json={"deviceToken": live["deviceToken"]},
    )
    assert adopted.status_code == 200
    assert adopted.json()["mediaAccountId"] == account["id"]
    assert adopted.json()["artifact"]["fingerprint"] == "zhihu-stranded-artifact"

    with SessionLocal() as db:
        bindings = [
            item for item in list_records(db, "mediaAccountBindings")
            if item.get("mediaAccountId") == account["id"] and item.get("status") == "active"
        ]
    assert bindings[-1]["deviceId"] == live["device"]["id"]


def test_successful_session_validation_restores_active_credential_health():
    device, _session, account = create_active_netease_account_for_publication_discovery()
    command = client.post(f"/api/media-accounts/{account['id']}/validate-session").json()["desktopCommand"]

    result = client.post(f"/api/desktop-commands/{command['id']}/events", json={
        "deviceId": device["device"]["id"],
        "deviceToken": device["deviceToken"],
        "type": "session_validation_succeeded",
        "payload": {
            "valid": True,
            "currentUrl": "https://mp.163.com/#/article/manage",
            "credentialMetadata": {"credentialExpiresAt": "2026-12-31T00:00:00.000Z"},
        },
    }).json()

    refreshed = client.get(f"/api/media-accounts/{account['id']}").json()
    assert result["command"]["status"] == "succeeded"
    assert refreshed["status"] == "active"
    assert refreshed["credentialStatus"] == "active"
    assert refreshed["consecutiveAuthFailures"] == 0
    assert refreshed["lastVerifiedAt"]
    assert refreshed["nextCredentialCheckAt"]


def test_session_validation_distinguishes_transient_failure_from_confirmed_logout():
    device, _session, account = create_active_netease_account_for_publication_discovery()
    transient_command = client.post(f"/api/media-accounts/{account['id']}/validate-session").json()["desktopCommand"]

    client.post(f"/api/desktop-commands/{transient_command['id']}/events", json={
        "deviceId": device["device"]["id"],
        "deviceToken": device["deviceToken"],
        "type": "session_validation_failed",
        "payload": {"errorMessage": "NETWORK_TIMEOUT"},
    })
    stale = client.get(f"/api/media-accounts/{account['id']}").json()
    assert stale["status"] == "active"
    assert stale["credentialStatus"] == "stale"
    assert stale["consecutiveAuthFailures"] == 1
    assert stale["nextCredentialCheckAt"]

    logout_command = client.post(f"/api/media-accounts/{account['id']}/validate-session").json()["desktopCommand"]
    client.post(f"/api/desktop-commands/{logout_command['id']}/events", json={
        "deviceId": device["device"]["id"],
        "deviceToken": device["deviceToken"],
        "type": "session_validation_failed",
        "payload": {"errorMessage": "NETEASE_LOGIN_REQUIRED"},
    })
    logged_out = client.get(f"/api/media-accounts/{account['id']}").json()
    assert logged_out["status"] == "needs_reauth"
    assert logged_out["credentialStatus"] == "needs_reauth"
    assert logged_out["consecutiveAuthFailures"] == 2


def test_desktop_command_events_require_matching_device_credentials_and_known_event_type():
    device = client.post("/api/desktop-devices/register", json={
        "deviceName": "Command owner",
        "platform": "windows",
        "appVersion": "0.2.0",
        "publicKey": "command-owner-key",
    }).json()
    other_device = client.post("/api/desktop-devices/register", json={
        "deviceName": "Other desktop",
        "platform": "windows",
        "appVersion": "0.2.0",
        "publicKey": "other-command-key",
    }).json()
    command = client.post("/api/desktop-commands", json={
        "deviceId": device["device"]["id"],
        "type": "open_auth",
        "payload": {"platform": "zhihu"},
    }).json()

    missing_token = client.post(f"/api/desktop-commands/{command['id']}/events", json={
        "deviceId": device["device"]["id"],
        "type": "running",
    })
    assert missing_token.status_code == 403

    wrong_device = client.post(f"/api/desktop-commands/{command['id']}/events", json={
        "deviceId": other_device["device"]["id"],
        "deviceToken": other_device["deviceToken"],
        "type": "running",
    })
    assert wrong_device.status_code == 403

    unsupported = client.post(f"/api/desktop-commands/{command['id']}/events", json={
        "deviceId": device["device"]["id"],
        "deviceToken": device["deviceToken"],
        "type": "forged_succeeded",
        "payload": {"publishedUrl": "https://example.com/forged"},
    })
    assert unsupported.status_code == 400
    assert unsupported.json()["detail"] == "DESKTOP_COMMAND_EVENT_INVALID"
    assert client.get(f"/api/desktop-commands/{command['id']}").json()["status"] == "queued"


def register_cleanup_command_device(public_key):
    return client.post("/api/desktop-devices/register", json={
        "deviceName": "Cleanup command desktop",
        "platform": "windows",
        "appVersion": "0.2.0",
        "publicKey": public_key,
    }).json()


def test_desktop_command_events_accept_cleanup_assets_terminal_events():
    device = register_cleanup_command_device("cleanup-command-owner-key")

    succeeded = client.post("/api/desktop-commands", json={
        "deviceId": device["device"]["id"],
        "type": "cleanup_assets",
        "payload": {"source": "scheduler"},
    }).json()
    response = client.post(f"/api/desktop-commands/{succeeded['id']}/events", json={
        "deviceId": device["device"]["id"],
        "deviceToken": device["deviceToken"],
        "type": "cleanup_succeeded",
        "payload": {"deleted": 12, "freedBytes": 4096},
    })
    assert response.status_code == 200
    assert client.get(f"/api/desktop-commands/{succeeded['id']}").json()["status"] == "succeeded"

    failed = client.post("/api/desktop-commands", json={
        "deviceId": device["device"]["id"],
        "type": "cleanup_assets",
        "payload": {"source": "scheduler"},
    }).json()
    response = client.post(f"/api/desktop-commands/{failed['id']}/events", json={
        "deviceId": device["device"]["id"],
        "deviceToken": device["deviceToken"],
        "type": "cleanup_failed",
        "payload": {"errorMessage": "profile locked"},
    })
    assert response.status_code == 200
    assert client.get(f"/api/desktop-commands/{failed['id']}").json()["status"] == "failed"


def test_legacy_agent_publish_failed_still_closes_a_cleanup_command():
    # An agent that predates the cleanup command maps every unknown type onto
    # publish_failed. Leaving that event unclaimable would strand the command
    # in running and block every later sweep for the device.
    device = register_cleanup_command_device("legacy-cleanup-agent-key")
    command = client.post("/api/desktop-commands", json={
        "deviceId": device["device"]["id"],
        "type": "cleanup_assets",
        "payload": {},
    }).json()

    response = client.post(f"/api/desktop-commands/{command['id']}/events", json={
        "deviceId": device["device"]["id"],
        "deviceToken": device["deviceToken"],
        "type": "publish_failed",
    })

    assert response.status_code == 200
    assert client.get(f"/api/desktop-commands/{command['id']}").json()["status"] == "failed"


def test_desktop_command_events_reject_an_unknown_cleanup_event():
    device = register_cleanup_command_device("forged-cleanup-event-key")
    command = client.post("/api/desktop-commands", json={
        "deviceId": device["device"]["id"],
        "type": "cleanup_assets",
        "payload": {},
    }).json()

    forged = client.post(f"/api/desktop-commands/{command['id']}/events", json={
        "deviceId": device["device"]["id"],
        "deviceToken": device["deviceToken"],
        "type": "cleanup_deleted_everything",
    })

    assert forged.status_code == 400
    assert forged.json()["detail"] == "DESKTOP_COMMAND_EVENT_INVALID"
    assert client.get(f"/api/desktop-commands/{command['id']}").json()["status"] == "queued"


def test_desktop_event_heartbeat_refreshes_the_stored_app_version():
    # Registration freezes appVersion, so a device that upgraded its installer
    # keeps the old number until a heartbeat reports the new one. The version
    # floor gates the destructive cleanup, so a frozen value silently disables it.
    device = register_cleanup_command_device("upgraded-desktop-key")
    device_id = device["device"]["id"]
    with SessionLocal() as db:
        assert get_record(db, "desktopDevices", device_id)["appVersion"] == "0.2.0"

    response = client.post(
        "/api/desktop-events",
        headers={"x-device-id": device_id, "x-device-token": device["deviceToken"]},
        json={
            "deviceId": device_id,
            "type": "heartbeat",
            "payload": {"appVersion": "0.1.14"},
        },
    )
    assert response.status_code == 200
    with SessionLocal() as db:
        assert get_record(db, "desktopDevices", device_id)["appVersion"] == "0.1.14"

    # Any other event payload is not version-shaped and must not be able to
    # rewrite what the agent reported about itself.
    client.post(
        "/api/desktop-events",
        headers={"x-device-id": device_id, "x-device-token": device["deviceToken"]},
        json={"deviceId": device_id, "type": "log", "payload": {"appVersion": "9.9.9"}},
    )
    with SessionLocal() as db:
        assert get_record(db, "desktopDevices", device_id)["appVersion"] == "0.1.14"


def test_desktop_asset_cleanup_keep_keys_require_the_device_token():
    device = register_cleanup_command_device("keep-keys-auth-key")
    device_id = device["device"]["id"]
    url = f"/api/desktop-devices/{device_id}/asset-cleanup-keep-keys"

    assert client.get(url).status_code == 403
    assert client.get(url, headers={"x-device-token": "not-the-token"}).status_code == 403

    granted = client.get(url, headers={"x-device-token": device["deviceToken"]})
    assert granted.status_code == 200
    assert granted.json()["keepProfileKeys"] == []


def test_desktop_asset_cleanup_keep_keys_span_every_owner():
    # Keeping a stale directory costs nothing; dropping a live one costs a
    # re-login. So the answer must not be narrowed to the device's own owner.
    device = register_cleanup_command_device("keep-keys-scope-key")
    device_id = device["device"]["id"]
    with SessionLocal() as db:
        save_record(db, "desktopDevices", {
            **get_record(db, "desktopDevices", device_id),
            "boundOwnerId": "owner-bound-to-this-device",
        })
        save_record(db, "mediaAccounts", {
            "id": "account-somebody-else",
            "name": "Somebody else account",
            "platform": "zhihu",
            "status": "active",
            "credentialStatus": "active",
            "ownerId": "owner-somebody-else",
            "profileKey": "profile-somebody-else",
        })
        save_record(db, "mediaAuthSessions", {
            "id": "session-somebody-else",
            "platform": "csdn",
            "status": "active",
            "ownerId": "owner-somebody-else",
        })
        save_record(db, "mediaAccountBindings", {
            "id": "binding-somebody-else",
            "mediaAccountId": "account-somebody-else",
            "profileKey": "profile-from-binding",
            "ownerId": "owner-somebody-else",
            "status": "active",
        })

    response = client.get(
        f"/api/desktop-devices/{device_id}/asset-cleanup-keep-keys",
        headers={"x-device-token": device["deviceToken"]},
    )

    assert response.status_code == 200
    keys = response.json()["keepProfileKeys"]
    assert keys == sorted(keys)
    assert {
        "account-somebody-else",
        "profile-somebody-else",
        "session-somebody-else",
        "profile-from-binding",
    } <= set(keys)


def test_media_auth_session_claim_requires_registered_device_token():
    device = client.post("/api/desktop-devices/register", json={
        "deviceName": "Claiming desktop",
        "platform": "windows",
        "appVersion": "0.2.0",
        "publicKey": "claiming-key",
    }).json()
    session = client.post("/api/media-auth-sessions", json={
        "platform": "zhihu",
        "deviceId": device["device"]["id"],
    }).json()["session"]

    missing = client.post(
        f"/api/desktop-devices/{device['device']['id']}/media-auth-sessions/{session['id']}/claim",
        json={"pairingCode": session["pairingCode"]},
    )
    assert missing.status_code == 403

    claimed = client.post(
        f"/api/desktop-devices/{device['device']['id']}/media-auth-sessions/{session['id']}/claim",
        json={"pairingCode": session["pairingCode"], "deviceToken": device["deviceToken"]},
    )
    assert claimed.status_code == 200


def test_desktop_command_poll_requires_device_credentials_and_only_returns_claimable_commands():
    device = client.post("/api/desktop-devices/register", json={
        "deviceName": "Polling desktop",
        "platform": "windows",
        "appVersion": "0.2.0",
        "publicKey": "polling-key",
    }).json()
    own = client.post("/api/desktop-commands", json={
        "deviceId": device["device"]["id"],
        "type": "open_auth",
        "payload": {},
    }).json()
    client.post("/api/desktop-commands", json={
        "deviceId": "another-device",
        "type": "open_auth",
        "payload": {},
    })

    assert client.get("/api/desktop-commands").status_code == 403
    response = client.get("/api/desktop-commands", headers={
        "x-device-id": device["device"]["id"],
        "x-device-token": device["deviceToken"],
    })

    assert response.status_code == 200
    assert [command["id"] for command in response.json()] == [own["id"]]


def test_save_record_replaces_text_utf8_cannot_encode():
    # The agent captures raw platform page text, so a mangled charset reaches us
    # as half an emoji. Postgres keeps it verbatim; encoding it back out is what
    # used to fail the whole response.
    lone = json.loads('"half \\ud83d done"')
    paired = json.loads('"whole \\ud83d\\ude00 done"')
    assert [ord(ch) for ch in lone if ord(ch) > 0xD7FF] == [0xD83D]
    assert [ord(ch) for ch in paired if ord(ch) > 0xD7FF] == [0x1F600]

    with SessionLocal() as db:
        stored = save_record(db, "desktopCommands", {
            "id": "command-with-broken-emoji",
            "deviceId": "device-1",
            "type": "publish_article",
            "result": {"pageText": lone, "kept": paired},
        })

        assert stored["result"]["pageText"] == "half \ufffd done"
        assert stored["result"]["kept"] == paired
        reloaded = get_record(db, "desktopCommands", "command-with-broken-emoji")
        assert reloaded["result"]["pageText"] == "half \ufffd done"
        json.dumps(reloaded).encode("utf-8")


def test_desktop_command_list_survives_a_row_poisoned_outside_the_write_guard():
    # save_record is the only guarded door, so this writes the row the way the
    # database already held it: straight past the guard. The list endpoint is
    # the one the agent polls, and a single such row used to 500 every device.
    device = client.post("/api/desktop-devices/register", json={
        "deviceName": "Poisoned row desktop",
        "platform": "windows",
        "appVersion": "0.2.0",
        "publicKey": "poisoned-row-key",
    }).json()
    own = client.post("/api/desktop-commands", json={
        "deviceId": device["device"]["id"],
        "type": "open_auth",
        "payload": {},
    }).json()
    with SessionLocal() as db:
        row = db.get(Record, own["id"])
        row.data = {**row.data, "result": {"pageText": json.loads('"half \\ud83d done"')}}
        db.commit()

    response = client.get("/api/desktop-commands", headers={
        "x-device-id": device["device"]["id"],
        "x-device-token": device["deviceToken"],
    })

    assert response.status_code == 200
    assert [command["id"] for command in response.json()] == [own["id"]]
    assert response.json()[0]["result"]["pageText"] == "half \ufffd done"


def test_desktop_command_detail_survives_a_row_poisoned_outside_the_write_guard():
    # The list guard alone would leave this path 500ing on the same row, which
    # is why the repair sits where every record leaves the database.
    device = client.post("/api/desktop-devices/register", json={
        "deviceName": "Poisoned detail desktop",
        "platform": "windows",
        "appVersion": "0.2.0",
        "publicKey": "poisoned-detail-key",
    }).json()
    own = client.post("/api/desktop-commands", json={
        "deviceId": device["device"]["id"],
        "type": "open_auth",
        "payload": {},
    }).json()
    with SessionLocal() as db:
        row = db.get(Record, own["id"])
        row.data = {**row.data, "result": {"pageText": json.loads('"half \\ud83d done"')}}
        db.commit()

    response = client.get(f"/api/desktop-commands/{own['id']}")

    assert response.status_code == 200
    assert response.json()["result"]["pageText"] == "half \ufffd done"


def test_sensitive_desktop_command_rejects_device_override_outside_account_binding():
    owner = client.post("/api/desktop-devices/register", json={
        "deviceName": "Account owner desktop",
        "platform": "windows",
        "appVersion": "0.2.0",
        "publicKey": "account-owner-key",
    }).json()
    other = client.post("/api/desktop-devices/register", json={
        "deviceName": "Unrelated desktop",
        "platform": "windows",
        "appVersion": "0.2.0",
        "publicKey": "unrelated-key",
    }).json()
    account = complete_media_authorization(
        owner,
        platform="zhihu",
        account_name="Bound publisher",
        fingerprint="bound-publisher",
    )["mediaAccount"]

    response = client.post("/api/desktop-commands", json={
        "deviceId": other["device"]["id"],
        "type": "publish_article",
        "mediaAccountId": account["id"],
        "payload": {"articleTitle": "Forged device override"},
    })

    assert response.status_code == 403
    assert response.json()["detail"] == "DESKTOP_COMMAND_DEVICE_MISMATCH"

    article = client.post("/api/articles", json={
        "title": "Shared helper device override",
        "keyword": "AI SEO",
        "status": "ready",
    }).json()
    shared_helper_response = client.post(f"/api/articles/{article['id']}/publish-from-context", json={
        "targetId": f"media:{account['id']}",
        "deviceId": other["device"]["id"],
        "confirmPublish": True,
    })
    assert shared_helper_response.status_code == 403
    assert shared_helper_response.json()["detail"] == "DESKTOP_COMMAND_DEVICE_MISMATCH"


def test_repeated_publish_success_event_reuses_media_order_and_index_submission():
    device = client.post("/api/desktop-devices/register", json={
        "deviceName": "Idempotent callback desktop",
        "platform": "windows",
        "appVersion": "0.2.0",
        "publicKey": "idempotent-callback-key",
    }).json()
    authorization = complete_media_authorization(
        device,
        platform="zhihu",
        account_name="Idempotent publisher",
        fingerprint="idempotent-publisher",
    )
    account = authorization["mediaAccount"]
    article = client.post("/api/articles", json={
        "title": "Idempotent media callback",
        "keyword": "AI SEO",
        "contentMarkdown": "Idempotent callback article body.",
        "status": "ready",
    }).json()
    command = client.post(f"/api/articles/{article['id']}/publish-from-context", json={
        "targetId": f"media:{account['id']}",
        "confirmPublish": True,
        "submitIndex": True,
    }).json()["desktopCommand"]
    event_payload = {
        "deviceId": device["device"]["id"],
        "deviceToken": device["deviceToken"],
        "type": "publish_succeeded",
        "payload": {
            "publishedUrl": "https://zhuanlan.zhihu.com/p/idempotent-callback",
            "platformStatus": "published",
            "publiclyVisible": True,
        },
    }

    first = client.post(f"/api/desktop-commands/{command['id']}/events", json=event_payload).json()
    second = client.post(f"/api/desktop-commands/{command['id']}/events", json=event_payload).json()

    assert second["mediaOrder"]["id"] == first["mediaOrder"]["id"]
    assert second["indexSubmission"] is None
    assert first["indexSubmission"] is None
    assert len(client.get("/api/media-orders").json()) == 1
    assert len(client.get("/api/index-submissions").json()) == 0

    late_failure = client.post(f"/api/desktop-commands/{command['id']}/events", json={
        "deviceId": device["device"]["id"],
        "deviceToken": device["deviceToken"],
        "type": "publish_failed",
        "payload": {"errorMessage": "LATE_FAILURE"},
    })
    assert late_failure.status_code == 409
    assert client.get(f"/api/desktop-commands/{command['id']}").json()["status"] == "succeeded"


def test_article_creation_preserves_publish_images_in_desktop_command():
    device = client.post("/api/desktop-devices/register", json={
        "deviceName": "Image publisher desktop",
        "platform": "windows",
        "appVersion": "0.2.0",
        "publicKey": "image-publisher-key",
    }).json()
    authorization = complete_media_authorization(
        device,
        platform="sohu",
        account_name="Image publisher",
        fingerprint="image-publisher",
    )
    account = authorization["mediaAccount"]
    article = client.post("/api/articles", json={
        "title": "Image publication article",
        "keyword": "image publish",
        "contentMarkdown": "# Image publication article\n\n## First\n\nBody with image.",
        "status": "ready",
        "sections": [{"id": "s1", "title": "First"}],
        "coverImage": {
            "assetId": "cover-1",
            "url": "/uploads/assets/cover-1.png",
            "path": "/app/uploads/assets/cover-1.png",
            "altText": "Cover",
        },
        "inlineImages": [{
            "assetId": "inline-1",
            "purpose": "inline",
            "sectionId": "s1",
            "url": "/uploads/assets/inline-1.png",
            "path": "/app/uploads/assets/inline-1.png",
            "altText": "Inline",
        }],
    }).json()

    assert article["coverImage"]["url"] == "/uploads/assets/cover-1.png"
    assert article["inlineImages"][0]["url"] == "/uploads/assets/inline-1.png"
    assert article["sections"][0]["id"] == "s1"

    command = client.post(f"/api/articles/{article['id']}/publish-from-context", json={
        "targetId": f"media:{account['id']}",
        "confirmPublish": True,
    }).json()["desktopCommand"]

    assert command["payload"]["coverImageUrl"] == "/uploads/assets/cover-1.png"
    assert command["payload"]["inlineImages"][0]["url"] == "/uploads/assets/inline-1.png"


def test_article_publish_context_preserves_explicit_baijiahao_disposable_gate_flags():
    device = client.post("/api/desktop-devices/register", json={
        "deviceName": "Baijiahao gate desktop",
        "platform": "windows",
        "appVersion": "0.2.0",
        "publicKey": "baijiahao-gate-key",
    }).json()
    authorization = complete_media_authorization(
        device,
        platform="baijiahao",
        account_name="Baijiahao gate account",
        fingerprint="baijiahao-gate-fingerprint",
    )
    article = client.post("/api/articles", json={
        "title": "Baijiahao disposable gate article",
        "keyword": "baijiahao gate",
        "contentMarkdown": "Baijiahao disposable gate body.",
        "status": "ready",
    }).json()

    command = client.post(f"/api/articles/{article['id']}/publish-from-context", json={
        "targetId": f"media:{authorization['mediaAccount']['id']}",
        "confirmPublish": True,
        "platformRules": {
            "apiFirst": True,
            "verifyPublication": True,
            "disposableTest": True,
            "preserveDraftOnManualVerification": True,
        },
    }).json()["desktopCommand"]

    assert command["payload"]["apiFirst"] is True
    assert command["payload"]["verifyPublication"] is True
    assert command["payload"]["disposableTest"] is True
    assert command["payload"]["preserveDraftOnManualVerification"] is True


def test_publish_command_defaults_to_latest_active_desktop_device_when_binding_is_stale():
    old_device = client.post("/api/desktop-devices/register", json={
        "deviceName": "Old desktop",
        "platform": "windows",
        "appVersion": "0.2.0",
        "publicKey": "stale-device-key",
    }).json()
    authorization = complete_media_authorization(
        old_device,
        platform="sohu",
        account_name="Stale binding publisher",
        fingerprint="stale-binding-publisher",
    )
    account = authorization["mediaAccount"]
    with SessionLocal() as db:
        patch_record(db, "desktopDevices", old_device["device"]["id"], {"lastSeenAt": "07/17 10:00", "updatedAt": "07/17 10:00"})
        current_device = save_record(db, "desktopDevices", {
            "id": "desktop-device-current-sohu",
            "deviceName": "Current desktop",
            "platform": "windows",
            "appVersion": "0.2.0",
            "publicKey": "stale-device-key",
            "deviceTokenHash": "current-token-hash",
            "status": "active",
            "ownerId": old_device["device"].get("ownerId") or "",
            "boundOwnerId": old_device["device"].get("boundOwnerId") or "",
            "lastSeenAt": "07/18 10:00",
            "createdAt": "07/18 09:59",
            "updatedAt": "07/18 10:00",
        })
        save_record(db, "desktopDevices", {
            "id": "desktop-device-unowned-rogue",
            "deviceName": "Unowned rogue desktop",
            "platform": "windows",
            "appVersion": "0.2.0",
            "publicKey": "stale-device-key",
            "deviceTokenHash": "rogue-token-hash",
            "status": "active",
            "ownerId": "legacy-internal-owner",
            "boundOwnerId": "",
            "lastSeenAt": "07/19 10:00",
            "createdAt": "07/19 09:59",
            "updatedAt": "07/19 10:00",
        })
    article = client.post("/api/articles", json={
        "title": "Latest desktop route",
        "keyword": "desktop route",
        "contentMarkdown": "Latest desktop route body.",
        "status": "ready",
    }).json()

    command = client.post(f"/api/articles/{article['id']}/publish-from-context", json={
        "targetId": f"media:{account['id']}",
        "confirmPublish": True,
    }).json()["desktopCommand"]

    assert command["deviceId"] == current_device["id"]


def test_auto_publish_latest_attempt_does_not_depend_on_database_return_order():
    with SessionLocal() as db:
        retry = save_record(db, "desktopCommands", {
            "id": "desktop-command-attempt-2",
            "deviceId": "desktop-ordering",
            "type": "publish_article",
            "mediaAccountId": "media-account-ordering",
            "payload": {
                "articleId": "article-ordering",
                "autoPublishTaskId": "auto-publish-ordering",
                "dedupeKey": "auto-publish-ordering:article-ordering:media-account-ordering",
                "attempt": 2,
            },
            "status": "succeeded",
        })
        save_record(db, "desktopCommands", {
            "id": "desktop-command-attempt-1",
            "deviceId": "desktop-ordering",
            "type": "publish_article",
            "mediaAccountId": "media-account-ordering",
            "payload": {
                "articleId": "article-ordering",
                "autoPublishTaskId": "auto-publish-ordering",
                "dedupeKey": "auto-publish-ordering:article-ordering:media-account-ordering",
                "attempt": 1,
            },
            "status": "failed",
        })

        current = current_auto_publish_commands(db, "auto-publish-ordering")

    assert [command["id"] for command in current] == [retry["id"]]


def test_auto_publish_retry_counts_only_the_latest_attempt_for_each_target():
    device = client.post("/api/desktop-devices/register", json={
        "deviceName": "Retry desktop",
        "platform": "windows",
        "appVersion": "0.2.0",
        "publicKey": "retry-key",
    }).json()
    authorization = complete_media_authorization(
        device,
        platform="zhihu",
        account_name="Retry publisher",
        fingerprint="retry-publisher",
    )
    account = authorization["mediaAccount"]
    article = client.post("/api/articles", json={
        "title": "Retry publication",
        "keyword": "AI SEO",
        "contentMarkdown": "Retry publication body.",
        "status": "ready",
    }).json()
    with SessionLocal() as db:
        batch = save_record(db, "autoPublishTasks", {
            "id": "auto-publish-retry-1",
            "name": "Retry batch",
            "articleIds": [article["id"]],
            "mediaAccountIds": [account["id"]],
            "status": "publishing",
        })

    queued = client.post(f"/api/articles/{article['id']}/publish-from-context", json={
        "targetId": f"media:{account['id']}",
        "autoPublishTaskId": batch["id"],
        "dedupeKey": f"{batch['id']}:{article['id']}:{account['id']}",
        "confirmPublish": True,
        "submitIndex": True,
    }).json()["desktopCommand"]
    failed = client.post(f"/api/desktop-commands/{queued['id']}/events", json={
        "deviceId": device["device"]["id"],
        "deviceToken": device["deviceToken"],
        "type": "publish_failed",
        "payload": {"errorMessage": "TEMPORARY_PLATFORM_ERROR"},
    })
    assert failed.status_code == 200

    retried = client.post(f"/api/auto-publish/{batch['id']}/retry-publishes")
    assert retried.status_code == 200
    retry_command = retried.json()["desktopCommands"][0]
    assert retry_command["id"] != queued["id"]
    assert retry_command["payload"]["dedupeKey"] == queued["payload"]["dedupeKey"]

    completed = client.post(f"/api/desktop-commands/{retry_command['id']}/events", json={
        "deviceId": device["device"]["id"],
        "deviceToken": device["deviceToken"],
        "type": "publish_succeeded",
        "payload": {
            "publishedUrl": "https://zhuanlan.zhihu.com/p/retry-success",
            "platformStatus": "published",
            "publiclyVisible": True,
        },
    })
    assert completed.status_code == 200

    stored = next(item for item in client.get("/api/auto-publish").json() if item["id"] == batch["id"])
    assert stored["status"] == "succeeded"
    assert stored["queuedPublishCount"] == 1
    assert stored["publishSucceededCount"] == 1
    assert stored["publishFailedCount"] == 0
    assert stored["desktopCommandIds"] == [retry_command["id"]]


def test_published_center_reports_container_utc_stamps_in_beijing_time():
    # Publish stamps written while the containers ran on a UTC clock carry that
    # clock's wall time. Reading one back has to land it in Beijing time, or the
    # published list stays eight hours behind the platforms themselves.
    article = client.post("/api/articles", json={
        "title": "Beijing publish timestamp",
        "keyword": "AI SEO",
        "status": "published",
        "publishStatus": "published",
    }).json()
    client.post("/api/media-orders", json={
        "articleId": article["id"],
        "articleTitle": article["title"],
        "resourceId": "account:media-account-beijing-stamp",
        "resourceName": "知乎运营号",
        "platform": "zhihu",
        "status": "succeeded",
        "backlinkStatus": "published",
        "backlinkUrl": "https://zhuanlan.zhihu.com/p/beijing-stamp",
        "platformStatus": "published",
        "createdAt": "2026-07-27 14:47:33",
        "updatedAt": "2026-07-27 14:47:33",
    })

    center = client.get("/api/published-center").json()

    record = next(item for item in center["records"] if item["articleTitle"] == article["title"])
    assert record["updatedAt"] == "2026-07-27T22:47:33+08:00"


def test_dashboard_and_article_management_use_free_media_publication_state():
    article = client.post("/api/articles", json={
        "title": "Media publication state",
        "keyword": "AI SEO",
        "status": "published",
        "publishStatus": "published",
    }).json()
    order = client.post("/api/media-orders", json={
        "articleId": article["id"],
        "articleTitle": article["title"],
        "resourceId": "account:media-account-dashboard",
        "resourceName": "知乎运营号",
        "platform": "zhihu",
        "status": "succeeded",
        "backlinkStatus": "published",
        "backlinkUrl": "https://zhuanlan.zhihu.com/p/dashboard-media",
        "platformStatus": "published",
        "createdAt": "2026-10-01T12:00:00+08:00",
        "updatedAt": "2026-10-01T12:00:00+08:00",
    }).json()
    client.post("/api/index-submissions", json={
        "articleId": article["id"],
        "articleTitle": article["title"],
        "url": order["backlinkUrl"],
        "provider": "IndexNow",
        "sourceType": "media",
        "sourceId": order["id"],
        "inclusionStatus": "indexed",
    })
    for index in range(8):
        extra_article = client.post("/api/articles", json={
            "title": f"Extra media publication {index}",
            "keyword": "AI SEO",
            "status": "published",
            "publishStatus": "published",
        }).json()
        client.post("/api/media-orders", json={
            "articleId": extra_article["id"],
            "articleTitle": extra_article["title"],
            "resourceId": f"account:media-account-dashboard-{index}",
            "resourceName": f"媒体账号 {index}",
            "platform": "zhihu",
            "status": "succeeded",
            "backlinkStatus": "published",
            "backlinkUrl": f"https://zhuanlan.zhihu.com/p/dashboard-extra-{index}",
            "platformStatus": "published",
            # Older, zone-explicit stamps so the newest record sorts first.
            "createdAt": "2026-01-01T08:00:00+08:00",
            "updatedAt": "2026-01-01T08:00:00+08:00",
        })
    with SessionLocal() as db:
        save_record(db, "desktopCommands", {
            "id": "desktop-command-dashboard-running",
            "deviceId": "desktop-dashboard",
            "type": "publish_article",
            "payload": {"articleId": article["id"]},
            "status": "running",
            "result": {},
            "createdAt": "2026-07-11 23:00",
            "updatedAt": "2026-07-11 23:00",
        })

    dashboard = client.get("/api/dashboard/metrics").json()
    assert dashboard["runningPublishes"] == 1
    assert dashboard["operationCenter"]["today"]["publishedUrls"] == 9
    assert len(dashboard["recentPublishes"]) == 8
    assert dashboard["recentPublishes"][0]["id"] == f"media:{order['id']}"
    assert dashboard["recentPublishes"][0]["channelName"] == "知乎运营号"

    center = client.get("/api/articles?view=management").json()
    record = next(item for item in center["records"] if item["articleId"] == article["id"])
    assert record["publishStatus"] == "succeeded"
    assert record["publishedUrl"] == order["backlinkUrl"]
    assert record["indexStatus"] == "pending"
    assert record["inclusionStatus"] == "indexed"


def test_article_cannot_queue_duplicate_site_publish_from_context():
    article = client.post("/api/articles", json={
        "title": "Single site publish article",
        "keyword": "single site publish",
        "status": "ready",
    }).json()
    site = client.post("/api/sites", json={
        "name": "Single publish site",
        "type": "Webhook",
        "baseUrl": "https://single-site.test",
    }).json()

    first = client.post(f"/api/articles/{article['id']}/publish-from-context", json={
        "targetId": f"site:{site['id']}",
    })
    duplicate = client.post(f"/api/articles/{article['id']}/publish-from-context", json={
        "targetId": f"site:{site['id']}",
    })

    assert first.status_code == 200
    assert client.get(f"/api/articles/{article['id']}").json()["publishStatus"] == "pending"
    assert duplicate.status_code == 409
    assert duplicate.json()["detail"]["code"] == "ARTICLE_PUBLISH_ALREADY_ACTIVE"


def test_article_cannot_queue_duplicate_media_market_publish_from_context():
    article = client.post("/api/articles", json={
        "title": "Single media market publish article",
        "keyword": "single media market publish",
        "status": "ready",
    }).json()
    resource = client.post("/api/media-resources", json={
        "name": "Single publish media resource",
        "type": "media-market",
    }).json()

    first = client.post(f"/api/articles/{article['id']}/publish-from-context", json={
        "targetId": f"resource:{resource['id']}",
    })
    duplicate = client.post(f"/api/articles/{article['id']}/publish-from-context", json={
        "targetId": f"resource:{resource['id']}",
    })

    assert first.status_code == 200
    assert client.get(f"/api/articles/{article['id']}").json()["publishStatus"] == "pending"
    assert duplicate.status_code == 409
    assert duplicate.json()["detail"]["code"] == "ARTICLE_PUBLISH_ALREADY_ACTIVE"

def test_direct_publish_and_index_claims_article_before_queueing():
    article = client.post("/api/articles", json={
        "title": "Direct single publish article",
        "keyword": "direct single publish",
        "status": "ready",
    }).json()
    site = client.post("/api/sites", json={
        "name": "Direct single publish site",
        "type": "Webhook",
        "baseUrl": "https://direct-single.test",
    }).json()

    first = client.post("/api/publish-and-index", json={
        "articleId": article["id"],
        "siteId": site["id"],
    })
    duplicate = client.post("/api/publish-and-index", json={
        "articleId": article["id"],
        "siteId": site["id"],
    })

    assert first.status_code == 200
    assert client.get(f"/api/articles/{article['id']}").json()["publishStatus"] == "pending"
    assert duplicate.status_code == 409
    assert duplicate.json()["detail"]["code"] == "ARTICLE_PUBLISH_ALREADY_ACTIVE"
def _scheduler_validation_commands() -> list[dict]:
    with SessionLocal() as db:
        return [
            item for item in list_records(db, "desktopCommands")
            if item.get("type") == "validate_session"
        ]


def _newly_queued_validation_commands() -> list[dict]:
    before = {item["id"] for item in _scheduler_validation_commands()}
    enqueued = _run_scheduler_validation_enqueue()
    created = [item for item in _scheduler_validation_commands() if item["id"] not in before]
    return enqueued, created


def _mark_validation_due(account_id: str) -> None:
    with SessionLocal() as db:
        patch_record(db, "mediaAccounts", account_id, {
            "nextCredentialCheckAt": "2020-01-01T00:00:00+00:00",
        })


def _run_scheduler_validation_enqueue() -> int:
    from app.worker import Scheduler

    with SessionLocal() as db:
        return Scheduler(db).enqueue_media_session_validations()


def test_scheduler_session_validation_reroutes_to_live_device_and_ignores_zombie_dedup():
    owner_id = "test-owner"
    stranded = _register_labelled_device("Scheduler Stranded Desktop", owner_id)
    account = complete_media_authorization(
        stranded,
        platform="zhihu",
        account_name="知乎调度搁浅账号",
        fingerprint="zhihu-scheduler-stranded",
    )["mediaAccount"]
    _patch_device(stranded["device"]["id"], owner_id, "01/01 00:00")
    live = _register_labelled_device("Scheduler Live Desktop", owner_id)
    _mark_validation_due(account["id"])

    enqueued, commands = _newly_queued_validation_commands()
    assert enqueued == 1
    assert len(commands) == 1
    assert commands[0]["payload"]["source"] == "scheduler"
    assert commands[0]["deviceId"] == live["device"]["id"]

    with SessionLocal() as db:
        bindings = [
            item for item in list_records(db, "mediaAccountBindings")
            if item.get("mediaAccountId") == account["id"] and item.get("status") == "active"
        ]
    assert bindings[-1]["deviceId"] == live["device"]["id"]

def test_scheduler_session_validation_skips_owner_without_a_live_device():
    owner_id = "test-owner"
    stranded = _register_labelled_device("Scheduler Offline Desktop", owner_id)
    account = complete_media_authorization(
        stranded,
        platform="jianshu",
        account_name="简书调度离线账号",
        fingerprint="jianshu-scheduler-offline",
    )["mediaAccount"]
    _patch_device(stranded["device"]["id"], owner_id, "01/01 00:00")
    _mark_validation_due(account["id"])

    assert _run_scheduler_validation_enqueue() == 0
    assert _scheduler_validation_commands() == []


def test_scheduler_session_validation_is_not_blocked_by_a_command_zombie_on_a_dead_device():
    owner_id = "test-owner"
    stranded = _register_labelled_device("Scheduler Zombie Desktop", owner_id)
    account = complete_media_authorization(
        stranded,
        platform="zhihu",
        account_name="知乎僵尸命令账号",
        fingerprint="zhihu-scheduler-zombie",
    )["mediaAccount"]
    _patch_device(stranded["device"]["id"], owner_id, "01/01 00:00")
    _mark_validation_due(account["id"])

    # The scheduler once stranded this command on a device that no longer exists.
    with SessionLocal() as db:
        save_record(db, "desktopCommands", {
            "id": "desktop-command-scheduler-zombie",
            "deviceId": stranded["device"]["id"],
            "type": "validate_session",
            "mediaAccountId": account["id"],
            "payload": {},
            "status": "queued",
            "result": {},
            "errorMessage": "",
            "createdAt": "01/01 00:00",
            "updatedAt": "01/01 00:00",
        })

    live = _register_labelled_device("Scheduler Rescue Desktop", owner_id)
    enqueued, commands = _newly_queued_validation_commands()
    assert enqueued == 1
    assert len(commands) == 1
    assert commands[0]["id"] != "desktop-command-scheduler-zombie"
    assert commands[0]["deviceId"] == live["device"]["id"]

    with SessionLocal() as db:
        bindings = [
            item for item in list_records(db, "mediaAccountBindings")
            if item.get("mediaAccountId") == account["id"] and item.get("status") == "active"
        ]
    assert bindings[-1]["deviceId"] == live["device"]["id"]
