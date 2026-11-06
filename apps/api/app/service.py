from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta
from typing import Any, Callable
from urllib.parse import urlsplit
from uuid import NAMESPACE_URL, uuid4, uuid5

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .auth.context import current_owner_id
from .app_time import (
    normalize_timestamps,
    now_stamp,
    parse_stored_timestamp,
    sanitize_unencodable_text,
    sortable_timestamp,
)
from .config import get_settings
from .database import Record
from .illustrated_content import build_content_blocks, compose_rich_article_html
from .knowledge import deterministic_embedding
from .queue import queue_client
from .repositories.workflow_records import delete_workflow_record, sync_workflow_record


logger = logging.getLogger(__name__)


LIST_KINDS = {
    "articles",
    "articleTypes",
    "sites",
    "publishJobs",
    "indexSubmissions",
    "assets",
    "assetTagGroups",
    "tasks",
    "keywords",
    "serpAnalyses",
    "competitors",
    "rankingEntries",
    "generationRules",
    "mediaAccounts",
    "autoPublishTasks",
    "geoQuestions",
    "watermarks",
    "mediaResources",
    "mediaOrders",
    "indexerConfigs",
    "knowledgeItems",
    "knowledgeChunks",
    "knowledgeVectors",
    "llmRequests",
    "seoProviderResults",
    "seoProviderConfigs",
    "taskLogs",
    "auditLogs",
    "notifications",
    "brandProfiles",
    "competitorProfiles",
    "desktopDevices",
    "mediaAuthSessions",
    "mediaAuthArtifacts",
    "mediaAccountBindings",
    "desktopCommands",
    "desktopEvents",
}

PUBLICATION_DISCOVERY_PLATFORMS = {"netease", "zhihu", "baijiahao", "penguin", "toutiao", "jianshu", "csdn", "sohu"}
REVIEW_PUBLICATION_DISCOVERY_PLATFORMS = {"netease", "penguin", "sohu", "toutiao", "jianshu"}
# Public article pages that the API server cannot read on its own: they answer a plain
# server-side fetch with an anti-bot 403, so only the desktop browser session can confirm
# that a supplied published URL really carries the article.
BROWSER_VERIFIED_PUBLICATION_PLATFORMS = {"zhihu"}


def is_private_creator_review_url(platform: str, url: str) -> bool:
    """Return true when a review URL points to a creator backend, not a public article."""
    if not url:
        return False
    try:
        parsed = urlsplit(url)
    except ValueError:
        return False
    hostname = (parsed.hostname or "").lower()
    if platform == "sohu":
        return hostname == "mp.sohu.com" or hostname == "passport.sohu.com"
    if platform == "netease":
        return hostname == "mp.163.com"
    if platform == "penguin":
        return hostname == "om.qq.com"
    if platform == "toutiao":
        return hostname == "mp.toutiao.com" or hostname == "creator.toutiao.com"
    if platform == "baijiahao":
        return hostname == "baijiahao.baidu.com" and not parsed.path.startswith("/s")
    if platform == "zhihu":
        return "write" in parsed.path or "draft" in parsed.path
    if platform == "jianshu":
        return "writer" in parsed.path or "notes" in parsed.path
    if platform == "csdn":
        return hostname in {"mp.csdn.net", "editor.csdn.net"} or "write" in parsed.path
    return False


def csdn_page_is_soft_unavailable(page_text: str) -> bool:
    normalized = normalize_publication_text(page_text)
    if not normalized:
        return False
    unavailable_markers = [
        "你想找的内容离你而去",
        "内容不存在",
        "内容还在审核中",
        "内容地址错误",
        "作者删除",
    ]
    return any(normalize_publication_text(marker) in normalized for marker in unavailable_markers)


def publication_page_is_soft_unavailable(platform: str, page_text: str) -> bool:
    normalized = normalize_publication_text(page_text)
    if not normalized:
        return False
    common_markers = [
        "\u5185\u5bb9\u88ab\u5220\u9664",
        "\u5185\u5bb9\u4e0d\u5b58\u5728",
        "\u6587\u7ae0\u4e0d\u5b58\u5728",
        "\u9875\u9762\u4e0d\u5b58\u5728",
        "\u9875\u9762\u5df2\u5220\u9664",
        "\u5df2\u4e0b\u7ebf",
        "notfound",
        "forbidden",
    ]
    platform_markers = {
        "penguin": [
            "\u8fd9\u7bc7\u6587\u7ae0\u4ece\u5730\u7403\u4e0a\u6d88\u5931\u4e86",
            "404.html",
        ],
        "csdn": [
            "\u4f60\u60f3\u627e\u7684\u5185\u5bb9\u79bb\u4f60\u800c\u53bb",
            "\u5185\u5bb9\u8fd8\u5728\u5ba1\u6838\u4e2d",
        ],
        "sohu": [
            "\u60a8\u8bbf\u95ee\u7684\u9875\u9762\u4e0d\u5b58\u5728",
            "\u5f88\u62b1\u6b49\uff0c\u60a8\u67e5\u770b\u7684\u9875\u9762\u627e\u4e0d\u5230\u4e86",
        ],
        "toutiao": [
            "\u8be5\u5185\u5bb9\u4e0d\u5b58\u5728",
            "\u6587\u7ae0\u5df2\u4e0b\u67b6",
        ],
        "netease": [
            "\u8be5\u6587\u7ae0\u5df2\u5220\u9664",
            "\u5185\u5bb9\u6b63\u5728\u5ba1\u6838",
        ],
    }
    markers = common_markers + platform_markers.get(str(platform or "").strip().lower(), [])
    return any(normalize_publication_text(marker) in normalized for marker in markers)


def candidate_publication_url_is_publishable(platform: str, url: str, page_text: str = "") -> bool:
    """Return true only for a platform's real public article URL shape.

    This is the shared fail-closed guard before a candidate can become a
    backlink. Creator, draft, management, review, and soft-unavailable pages
    are still useful evidence, but they must stay out of backlinkUrl.
    """
    platform = str(platform or "").strip().lower()
    if not is_public_http_url(url):
        return False
    if is_private_creator_review_url(platform, url):
        return False
    try:
        parsed = urlsplit(str(url or "").strip())
    except ValueError:
        return False
    hostname = (parsed.hostname or "").lower()
    path = parsed.path or ""
    if re.search(r"(^|/)404(?:\.html)?/?$", path, re.I):
        return False
    if publication_page_is_soft_unavailable(platform, page_text):
        return False
    if platform == "sohu":
        return hostname == "www.sohu.com" and bool(re.match(r"^/a/\d+_\d+", path))
    if platform == "netease":
        return hostname in {"www.163.com", "dy.163.com"} and "/dy/article/" in path and path.endswith(".html")
    if platform == "penguin":
        return hostname == "page.om.qq.com" and path.startswith("/page/")
    if platform == "toutiao":
        return hostname in {"www.toutiao.com", "toutiao.com"} and bool(re.match(r"^/(article|item)/\d+/?$", path))
    if platform == "baijiahao":
        return hostname == "baijiahao.baidu.com" and path == "/s" and bool(parsed.query)
    if platform == "zhihu":
        return hostname in {"zhuanlan.zhihu.com", "www.zhihu.com"} and bool(re.match(r"^/p/\d+", path))
    if platform == "jianshu":
        return hostname in {"www.jianshu.com", "jianshu.com"} and bool(re.match(r"^/p/[0-9a-zA-Z]+", path))
    if platform == "csdn":
        if hostname != "blog.csdn.net" or "/article/details/" not in path:
            return False
        return not csdn_page_is_soft_unavailable(page_text)
    return True


def publication_discovery_required(platform: str, candidate_url: str, discovery_status: str, force: bool = False) -> bool:
    platform = str(platform or "")
    discovery_status = str(discovery_status or "")
    if platform not in REVIEW_PUBLICATION_DISCOVERY_PLATFORMS:
        return False
    return (
        force
        or not candidate_url
        or is_private_creator_review_url(platform, candidate_url)
        or discovery_status in {"pending", "not_found", "failed"}
    )


STALE_DESKTOP_DISCOVERY_SECONDS = 3600


def parse_desktop_command_timestamp(value: Any, now: datetime | None = None) -> datetime | None:
    """Resolve a stored desktop-command stamp into an aware datetime.

    ``now`` only lets tests pin the reference moment; the zone the value is read
    in always comes from the offset the stamp itself carries.
    """
    return parse_stored_timestamp(value, current=now)


def stale_running_desktop_discovery_command(command: dict, now: datetime | None = None) -> bool:
    if command.get("type") != "discover_publication" or command.get("status") != "running":
        return False
    timestamp = parse_desktop_command_timestamp(command.get("updatedAt") or command.get("createdAt"), now=now)
    if not timestamp:
        return False
    current = now or datetime.now(timestamp.tzinfo)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timestamp.tzinfo)
    else:
        current = current.astimezone(timestamp.tzinfo)
    return (current - timestamp).total_seconds() >= STALE_DESKTOP_DISCOVERY_SECONDS

PREFIX_BY_KIND = {
    "articles": "article",
    "articleTypes": "article-type",
    "sites": "site",
    "publishJobs": "publish",
    "indexSubmissions": "index",
    "assets": "asset",
    "assetTagGroups": "tag-group",
    "tasks": "task",
    "keywords": "keyword",
    "serpAnalyses": "serp",
    "competitors": "competitor",
    "rankingEntries": "rank",
    "generationRules": "rule",
    "mediaAccounts": "media-account",
    "autoPublishTasks": "auto-publish",
    "geoQuestions": "geo-question",
    "watermarks": "watermark",
    "mediaResources": "media-resource",
    "mediaOrders": "media-order",
    "indexerConfigs": "indexer",
    "knowledgeItems": "knowledge",
    "knowledgeChunks": "knowledge-chunk",
    "knowledgeVectors": "knowledge-vector",
    "llmRequests": "llm-request",
    "seoProviderResults": "seo-provider-result",
    "seoProviderConfigs": "seo-provider-config",
    "taskLogs": "task-log",
    "auditLogs": "audit-log",
    "notifications": "notification",
    "brandProfiles": "brand",
    "competitorProfiles": "competitor-profile",
    "desktopDevices": "desktop-device",
    "mediaAuthSessions": "media-auth-session",
    "mediaAuthArtifacts": "media-auth-artifact",
    "mediaAccountBindings": "media-account-binding",
    "desktopCommands": "desktop-command",
    "desktopEvents": "desktop-event",
}

INDEX_PROVIDERS = ["Google", "Baidu", "IndexNow", "Sitemap", "DataForSEO"]

ACTIVE_ARTICLE_WORKFLOW_KINDS = (
    "tasks",
    "desktopCommands",
    "publishJobs",
    "mediaOrders",
    "autoPublishTasks",
)
ACTIVE_ARTICLE_WORKFLOW_STATUSES = {
    "queued",
    "pending",
    "running",
    "processing",
    "publishing",
    "retry",
}
ARTICLE_HISTORY_KINDS = (
    "publishJobs",
    "mediaOrders",
    "indexSubmissions",
)
ARTICLE_DELETION_BLOCKING_TYPES = {
    "tasks": {"publish-and-index", "media-backlink-index", "auto-publish"},
    "desktopCommands": {"publish_article"},
}


def make_id(kind: str) -> str:
    return f"{PREFIX_BY_KIND.get(kind, kind)}-{uuid4().hex[:12]}"


def clean_strings(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


def clean_dict(value: Any) -> dict:
    return value if isinstance(value, dict) else {}


def clean_dicts(value: Any) -> list[dict]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def desktop_device_recency_timestamp(device: dict | None) -> float:
    if not isinstance(device, dict):
        return 0
    value = str(device.get("lastSeenAt") or device.get("updatedAt") or device.get("createdAt") or "").strip()
    parsed = parse_stored_timestamp(value)
    return parsed.timestamp() if parsed else 0.0


def sanitize_provider_error(error: Exception) -> str:
    message = str(error)
    message = re.sub(
        r"([?&](?:token|key|api_key|password|secret)=)[^&\s]+",
        r"\1[REDACTED]",
        message,
        flags=re.IGNORECASE,
    )
    message = re.sub(r"(Bearer\s+)[A-Za-z0-9._~+\-/=]+", r"\1[REDACTED]", message, flags=re.IGNORECASE)
    return message


def normalize_url_part(value: str) -> str:
    return "".join(ch.lower() if ch.isalnum() else "-" for ch in value).strip("-")[:80] or uuid4().hex[:8]


def _record_owner_for_write(data: dict) -> str:
    actor_owner_id = current_owner_id()
    if actor_owner_id:
        return actor_owner_id
    explicit_owner_id = str(data.get("ownerId") or "").strip()
    if explicit_owner_id:
        return explicit_owner_id
    test_owner_id = get_settings().auth_test_bypass_user_id.strip()
    if test_owner_id:
        return test_owner_id
    return "legacy-internal-owner"


def list_records(db: Session, kind: str) -> list[dict]:
    statement = select(Record).where(Record.kind == kind)
    actor_owner_id = current_owner_id()
    if actor_owner_id:
        statement = statement.where(Record.owner_id == actor_owner_id)
    rows = db.scalars(statement.order_by(Record.created_at.asc(), Record.id.asc())).all()
    return [normalize_timestamps(dict(row.data)) for row in rows]


def list_desktop_command_records(db: Session, device_id: str) -> list[dict]:
    target = func.coalesce(Record.data["deviceId"].as_string(), "")
    statement = select(Record).where(
        Record.kind == "desktopCommands",
        target.in_([device_id, ""]),
    )
    owner_id = current_owner_id()
    if owner_id:
        statement = statement.where(Record.owner_id == owner_id)
    rows = db.scalars(statement.order_by(Record.created_at.asc(), Record.id.asc())).all()
    return [normalize_timestamps(dict(row.data)) for row in rows]

def dashboard_task_records(db: Session) -> tuple[list[dict], list[dict]]:
    statement = select(Record).where(Record.kind == "tasks")
    owner_id = current_owner_id()
    if owner_id:
        statement = statement.where(Record.owner_id == owner_id)
    failed = db.scalars(statement.where(Record.data["status"].as_string() == "failed").order_by(Record.created_at, Record.id)).all()
    recent = db.scalars(statement.order_by(Record.created_at.desc(), Record.id.desc()).limit(8)).all()
    return (
        [normalize_timestamps(dict(row.data)) for row in failed],
        [normalize_timestamps(dict(row.data)) for row in reversed(recent)],
    )


def dashboard_running_publish_count(db: Session) -> int:
    statement = select(func.count()).select_from(Record).where(
        Record.kind == "desktopCommands",
        Record.data["type"].as_string() == "publish_article",
        Record.data["status"].as_string().in_(["queued", "running"]),
    )
    owner_id = current_owner_id()
    if owner_id:
        statement = statement.where(Record.owner_id == owner_id)
    return int(db.scalar(statement) or 0)


def media_account_platform_key(account: dict) -> str:
    return str(account.get("platform") or "").strip().lower()


def media_account_slot_key(account: dict) -> str:
    # A publishing identity is scoped to its owner: two owners on the same
    # platform are separate slots, not duplicates of one another.
    owner_id = str(account.get("ownerId") or "").strip()
    platform = media_account_platform_key(account) or str(account.get("id") or "")
    slot = f"{owner_id}/{platform}" if owner_id else platform
    if platform == "douyin":
        config = account.get("platformConfig") or {}
        uid = str(config.get("accountId") or "").strip()
        # Legacy unidentified records must never collapse into another login.
        return f"{slot}/uid:{uid}" if uid else f"{slot}/legacy:{account.get('id')}"
    return slot


def media_account_recency_timestamp(account: dict) -> float:
    timestamps = []
    for field in ("lastVerifiedAt", "lastCheckedAt", "updatedAt", "createdAt"):
        value = str(account.get(field) or "").strip()
        if not value:
            continue
        parsed = parse_stored_timestamp(value)
        if parsed is not None:
            timestamps.append(parsed.timestamp())
    return max(timestamps, default=0.0)


def media_account_recency_key(account: dict) -> tuple[int, int, float, str]:
    status_active = account.get("status") == "active"
    credential_active = account.get("credentialStatus") == "active"
    has_artifact = bool(account.get("authArtifactId"))
    health_rank = (
        4 if status_active and credential_active and has_artifact
        else 3 if status_active and credential_active
        else 2 if status_active and has_artifact
        else 1 if status_active
        else 0
    )
    return (
        1 if account.get("isCanonical") is True else 0,
        health_rank,
        media_account_recency_timestamp(account),
        str(account.get("id") or ""),
    )


def list_canonical_media_accounts(db: Session) -> list[dict]:
    canonical_by_slot: dict[str, dict] = {}
    for account in list_records(db, "mediaAccounts"):
        if account.get("status") == "superseded" or account.get("supersededByAccountId"):
            continue
        slot = media_account_slot_key(account)
        current = canonical_by_slot.get(slot)
        if current is None or media_account_recency_key(account) > media_account_recency_key(current):
            canonical_by_slot[slot] = account
    return list(canonical_by_slot.values())


def desktop_asset_cleanup_keep_profile_keys(db: Session) -> set[str]:
    """Collect every profile key that still backs a login, across all owners.

    Deliberately unscoped, and shared by the scheduler and the desktop-facing
    endpoint so the two can never disagree about what is protected. Deriving the
    set inside one owner's actor scope would drop every other user's key: the
    legacy-internal-owner devices cannot see the real users' mediaAccounts at
    all, and a conservative cleanup would turn into a mass logout. Keeping a key
    that is no longer needed costs a stale directory; dropping a live one costs
    a re-login.
    """
    keys: set[str] = set()
    for account in list_records(db, "mediaAccounts"):
        for value in (account.get("id"), account.get("profileKey")):
            key = str(value or "").strip()
            if key:
                keys.add(key)
    for session in list_records(db, "mediaAuthSessions"):
        # The agent falls back to the session id when no profile key is bound.
        key = str(session.get("profileKey") or session.get("id") or "").strip()
        if key:
            keys.add(key)
    for binding in list_records(db, "mediaAccountBindings"):
        key = str(binding.get("profileKey") or "").strip()
        if key:
            keys.add(key)
    return keys


def supersede_duplicate_media_accounts(db: Session) -> dict[str, int]:
    accounts = list_records(db, "mediaAccounts")
    canonical_accounts = list_canonical_media_accounts(db)
    canonical_by_slot = {
        media_account_slot_key(account): account
        for account in canonical_accounts
    }
    bindings = list_records(db, "mediaAccountBindings")
    artifacts = list_records(db, "mediaAuthArtifacts")
    superseded = 0

    for slot, canonical in canonical_by_slot.items():
        if canonical.get("isCanonical") is not True or canonical.get("supersededByAccountId"):
            canonical = patch_record(db, "mediaAccounts", canonical["id"], {
                "isCanonical": True,
                "supersededByAccountId": "",
                "supersededAt": "",
            })
            canonical_by_slot[slot] = canonical
        canonical_binding = next((
            binding for binding in reversed(bindings)
            if binding.get("mediaAccountId") == canonical["id"] and binding.get("status") == "active"
        ), None)
        canonical_artifact_id = str(canonical.get("authArtifactId") or "")

        for account in accounts:
            if media_account_slot_key(account) != slot or account.get("id") == canonical["id"]:
                continue
            if account.get("status") != "superseded" or account.get("supersededByAccountId") != canonical["id"]:
                patch_record(db, "mediaAccounts", account["id"], {
                    "status": "superseded",
                    "credentialStatus": "revoked",
                    "isCanonical": False,
                    "supersededByAccountId": canonical["id"],
                    "supersededAt": now_stamp(),
                })
                superseded += 1
            for binding in bindings:
                if binding.get("mediaAccountId") == account["id"] and binding.get("status") == "active":
                    patch_record(db, "mediaAccountBindings", binding["id"], {
                        "status": "superseded",
                        "supersededBy": canonical_binding.get("id") if canonical_binding else "",
                    })
            account_artifact_id = str(account.get("authArtifactId") or "")
            for artifact in artifacts:
                if (
                    artifact.get("mediaAccountId") == account["id"]
                    or (account_artifact_id and artifact.get("id") == account_artifact_id)
                ) and artifact.get("status") != "superseded":
                    patch_record(db, "mediaAuthArtifacts", artifact["id"], {
                        "status": "superseded",
                        "supersededBy": canonical_artifact_id,
                    })

    return {"platforms": len(canonical_by_slot), "superseded": superseded}


def resolve_media_account(db: Session, account_id: str) -> dict:
    account = get_record(db, "mediaAccounts", account_id)
    visited = {account_id}
    while account.get("supersededByAccountId"):
        canonical_id = str(account.get("supersededByAccountId") or "")
        if not canonical_id or canonical_id in visited:
            break
        canonical = find_record(db, "mediaAccounts", canonical_id)
        if not canonical:
            break
        visited.add(canonical_id)
        account = canonical
    return account


def _owned_record_statement(kind: str, record_id: str):
    statement = select(Record).where(Record.id == record_id, Record.kind == kind)
    actor_owner_id = current_owner_id()
    if actor_owner_id:
        statement = statement.where(Record.owner_id == actor_owner_id)
    return statement


def get_record(db: Session, kind: str, record_id: str) -> dict:
    row = db.scalar(_owned_record_statement(kind, record_id))
    if row is None:
        raise HTTPException(status_code=404, detail=f"{kind.upper()}_NOT_FOUND")
    return normalize_timestamps(dict(row.data))


def find_record(db: Session, kind: str, record_id: str) -> dict | None:
    row = db.scalar(_owned_record_statement(kind, record_id))
    return normalize_timestamps(dict(row.data)) if row is not None else None


def save_record(db: Session, kind: str, data: dict) -> dict:
    record_id = data.get("id") or make_id(kind)
    owner_id = _record_owner_for_write(data)
    existing = db.get(Record, record_id)
    actor_owner_id = current_owner_id()
    if existing is not None and actor_owner_id and existing.owner_id != actor_owner_id:
        raise HTTPException(status_code=404, detail=f"{kind.upper()}_NOT_FOUND")
    raw = {**data, "id": record_id, "ownerId": owner_id}
    stored = sanitize_unencodable_text(raw)
    if stored != raw:
        # The desktop agent captures raw platform page text, so a mangled
        # charset can reach us as half an emoji. The record stays usable, but
        # the stored text is already corrupt and that is worth knowing about.
        logger.warning(
            "record data held text UTF-8 cannot encode; replaced with U+FFFD: kind=%s id=%s",
            kind,
            record_id,
        )
    if existing:
        existing.data = stored
        existing.kind = kind
        existing.owner_id = owner_id
    else:
        db.add(Record(id=record_id, kind=kind, owner_id=owner_id, data=stored))
    sync_workflow_record(db, kind, stored)
    try:
        db.commit()
        return stored
    except IntegrityError as exc:
        db.rollback()
        # The fallback below hands back the row as it stands, so without a log
        # line a write that never landed was indistinguishable from one that
        # did. A dangling foreign key left in the payload is the usual culprit.
        logger.error(
            "record write rolled back on an integrity conflict: kind=%s id=%s owner=%s error=%s",
            kind,
            record_id,
            owner_id,
            _integrity_error_reason(exc),
        )
        concurrent = db.get(Record, record_id)
        if concurrent and concurrent.kind == kind and (not actor_owner_id or concurrent.owner_id == actor_owner_id):
            return dict(concurrent.data)
        raise


def _integrity_error_reason(exc: IntegrityError) -> str:
    """First line of the driver error, which is the part naming the constraint."""
    message = str(exc).strip()
    return message.splitlines()[0] if message else exc.__class__.__name__

def audit_event(db: Session, action: str, target_type: str, target_id: str, detail: dict | None = None, actor: str = "system") -> dict:
    return save_record(db, "auditLogs", {
        "id": make_id("auditLogs"),
        "action": action,
        "actor": actor,
        "targetType": target_type,
        "targetId": target_id,
        "detail": detail or {},
        "createdAt": now_stamp(),
    })


def log_task_event(db: Session, task_id: str, event: str, message: str, level: str = "info", detail: dict | None = None) -> dict:
    return save_record(db, "taskLogs", {
        "id": make_id("taskLogs"),
        "taskId": task_id,
        "event": event,
        "level": level,
        "message": message,
        "detail": detail or {},
        "createdAt": now_stamp(),
    })


def patch_record(db: Session, kind: str, record_id: str, patch: dict) -> dict:
    current = get_record(db, kind, record_id)
    updated = {**current, **patch, "id": record_id, "updatedAt": now_stamp()}
    return save_record(db, kind, updated)


def delete_record(db: Session, kind: str, record_id: str) -> bool:
    row = db.scalar(_owned_record_statement(kind, record_id))
    if row is None:
        raise HTTPException(status_code=404, detail=f"{kind.upper()}_NOT_FOUND")
    delete_workflow_record(db, kind, record_id)
    db.delete(row)
    db.commit()
    return True


def referenced_article_ids(value: Any) -> set[str]:
    """Extract explicit article references from a structured record payload."""
    article_ids: set[str] = set()
    if isinstance(value, dict):
        for key, child in value.items():
            if key == "articleId" and child:
                article_ids.add(str(child))
            elif key in {"articleIds", "generatedArticleIds"} and isinstance(child, list):
                article_ids.update(str(item) for item in child if item)
            elif isinstance(child, (dict, list)):
                article_ids.update(referenced_article_ids(child))
    elif isinstance(value, list):
        for child in value:
            if isinstance(child, (dict, list)):
                article_ids.update(referenced_article_ids(child))
    return article_ids


def article_active_workflows(db: Session, article_id: str) -> list[dict]:
    workflows: list[dict] = []
    for kind in ACTIVE_ARTICLE_WORKFLOW_KINDS:
        for record in list_records(db, kind):
            status = str(record.get("status") or "").lower()
            if status not in ACTIVE_ARTICLE_WORKFLOW_STATUSES:
                continue
            if article_id not in referenced_article_ids(record):
                continue
            blocking_types = ARTICLE_DELETION_BLOCKING_TYPES.get(kind)
            workflow_type = str(record.get("type") or record.get("queue") or kind)
            if blocking_types is not None and workflow_type not in blocking_types:
                continue
            workflows.append({
                "id": record["id"],
                "kind": kind,
                "status": status,
                "type": workflow_type,
            })
    return workflows


def article_retained_history(db: Session, article_id: str) -> dict[str, int]:
    counts = {
        kind: sum(
            article_id in referenced_article_ids(record)
            for record in list_records(db, kind)
        )
        for kind in ARTICLE_HISTORY_KINDS
    }
    completed_workflows = sum(
        article_id in referenced_article_ids(record)
        and str(record.get("status") or "").lower() not in ACTIVE_ARTICLE_WORKFLOW_STATUSES
        for kind in ("tasks", "desktopCommands", "autoPublishTasks")
        for record in list_records(db, kind)
    )
    return {**counts, "completedWorkflows": completed_workflows}


def delete_articles(db: Session, article_ids: list[str]) -> dict:
    unique_ids = list(dict.fromkeys(str(article_id).strip() for article_id in article_ids if str(article_id).strip()))
    if not unique_ids:
        raise HTTPException(status_code=400, detail="ARTICLE_IDS_REQUIRED")

    articles = [get_record(db, "articles", article_id) for article_id in unique_ids]
    for article in articles:
        active_workflows = article_active_workflows(db, article["id"])
        if active_workflows:
            article_title = article.get("title") or "δ��������"
            raise HTTPException(status_code=409, detail={
                "code": "ARTICLE_DELETE_ACTIVE_WORKFLOW",
                "message": f"��{article_title}������ִ���еķ���������ȴ�������ɻ�ʧ�ܺ���ɾ����",
                "articleId": article["id"],
                "articleTitle": article_title,
                "activeWorkflows": active_workflows,
            })

    deleted_items = []
    retained_totals = {
        "publishJobs": 0,
        "mediaOrders": 0,
        "indexSubmissions": 0,
        "completedWorkflows": 0,
    }
    for article in articles:
        retained_history = article_retained_history(db, article["id"])
        for key, count in retained_history.items():
            retained_totals[key] += count
        row = db.get(Record, article["id"])
        if row:
            db.delete(row)
        deleted_item = {
            "deleted": True,
            "articleId": article["id"],
            "title": article.get("title") or "δ��������",
            "retainedHistory": retained_history,
        }
        deleted_items.append(deleted_item)
        audit_id = make_id("auditLogs")
        db.add(Record(id=audit_id, kind="auditLogs", data={
            "id": audit_id,
            "action": "article.delete",
            "actor": "user",
            "targetType": "articles",
            "targetId": article["id"],
            "detail": {
                "title": deleted_item["title"],
                "publishedUrl": article.get("publishedUrl") or "",
                "retainedHistory": retained_history,
            },
            "createdAt": now_stamp(),
        }))

    db.commit()
    return {
        "requested": len(unique_ids),
        "deleted": len(deleted_items),
        "articleIds": unique_ids,
        "retainedHistory": retained_totals,
        "items": deleted_items,
    }


def score_article(article: dict) -> dict:
    content = str(article.get("contentMarkdown") or "")
    keywords = clean_strings(article.get("keywords"))
    title = str(article.get("title") or "")
    score = 45
    if len(content) > 600:
        score += 15
    if keywords:
        score += 15
    if any(keyword.lower() in title.lower() for keyword in keywords):
        score += 10
    if "##" in content:
        score += 10
    return {
        "totalScore": min(score, 100),
        "seoScore": min(score + 2, 100),
        "geoScore": min(score - 3, 100),
        "readabilityScore": min(score + 5, 100),
        "suggestions": [] if score >= 80 else ["�������Ľṹ���ؼ��ʺ� FAQ ���ٷ�����"],
    }


def default_article(payload: dict) -> dict:
    keyword = str(payload.get("keyword") or payload.get("primaryKeyword") or payload.get("title") or "AI SEO").strip()
    title = str(payload.get("title") or f"{keyword}��AI SEO ���ݷ����ջ�").strip()
    content = payload.get("contentMarkdown") or (
        f"# {title}\n\n"
        f"## {keyword} ��������ͼ\n\n"
        "Χ�ƹؼ��ʡ�SERP��֪ʶ���Ʒ���ز����ɿɷ������ġ�\n\n"
        "## ������۲�\n\n"
        "���±����ɽ���༭����ѡ��վ�㡢���ý�������ý�壬����д���� URL ��ƽ̨״̬��\n"
    )
    article = {
        "title": title,
        "seoTitle": payload.get("seoTitle") or title,
        "summary": payload.get("summary") or payload.get("metaDescription") or f"{keyword} �� SEO/GEO �����ݸ�",
        "metaDescription": payload.get("metaDescription") or f"{keyword} �� SEO/GEO �����ݸ�",
        "keyword": keyword,
        "keywords": clean_strings(payload.get("keywords")) or [keyword],
        "contentMarkdown": content,
        "status": payload.get("status") or "ready",
        "source": payload.get("source") or payload.get("mode") or "manual_ai",
        "articleType": payload.get("articleType") or payload.get("articleTypeName") or "",
        "ruleId": payload.get("ruleId") or "",
        "ruleName": payload.get("ruleName") or "",
        "tags": clean_strings(payload.get("tags")),
        "sections": clean_dicts(payload.get("sections")),
        "contentBlocks": clean_dicts(payload.get("contentBlocks")),
        "coverImage": clean_dict(payload.get("coverImage")),
        "inlineImages": clean_dicts(payload.get("inlineImages")),
        "assetIds": clean_strings(payload.get("assetIds")),
        "imageGenerationStatus": payload.get("imageGenerationStatus") or "",
        "imageErrors": clean_dicts(payload.get("imageErrors")),
        "quality": payload.get("quality") if isinstance(payload.get("quality"), dict) else {},
        "writerContext": payload.get("writerContext") if isinstance(payload.get("writerContext"), dict) else payload,
        "llmProvider": payload.get("llmProvider") or "",
        "llmModel": payload.get("llmModel") or "",
        "createdAt": payload.get("createdAt") or now_stamp(),
        "updatedAt": payload.get("updatedAt") or now_stamp(),
    }
    article["score"] = payload.get("score") or score_article(article)
    return article


def create_article(db: Session, payload: dict) -> dict:
    article = default_article(payload)
    article["id"] = payload.get("id") or make_id("articles")
    saved = save_record(db, "articles", article)
    audit_event(db, "article.create", "articles", saved["id"], {"source": saved.get("source")})
    return saved


def default_site(payload: dict) -> dict:
    site_type = payload.get("type") or payload.get("siteType") or "Webhook"
    return {
        "name": payload.get("name") or f"{site_type} ����",
        "type": site_type,
        "siteType": payload.get("siteType") or site_type,
        "baseUrl": payload.get("baseUrl") or "https://example.com",
        "webhookUrl": payload.get("webhookUrl") or "",
        "webhookSecret": payload.get("webhookSecret") or "",
        "defaultCategory": payload.get("defaultCategory") or "",
        "defaultTags": clean_strings(payload.get("defaultTags")),
        "strategyCount": int(payload.get("strategyCount") or 0),
        "members": int(payload.get("members") or 1),
        "status": payload.get("status") or "active",
        "lastPublishedAt": payload.get("lastPublishedAt") or "",
        "createdAt": payload.get("createdAt") or now_stamp(),
        "updatedAt": payload.get("updatedAt") or now_stamp(),
    }


def create_site(db: Session, payload: dict) -> dict:
    site = default_site(payload)
    site["id"] = payload.get("id") or make_id("sites")
    return save_record(db, "sites", site)


def default_by_kind(kind: str, payload: dict) -> dict:
    label = payload.get("name") or payload.get("title") or payload.get("filename") or PREFIX_BY_KIND.get(kind, kind)
    base = {
        **payload,
        "id": payload.get("id") or make_id(kind),
        "createdAt": payload.get("createdAt") or now_stamp(),
        "updatedAt": payload.get("updatedAt") or now_stamp(),
    }
    if kind == "assets":
        base.update({
            "filename": payload.get("filename") or f"asset-{uuid4().hex[:6]}.png",
            "type": payload.get("type") or "inline",
            "source": payload.get("source") or "upload",
            "altText": payload.get("altText") or label,
            "relatedArticle": payload.get("relatedArticle") or "",
            "tags": clean_strings(payload.get("tags")),
            "color": payload.get("color") or "#f1f5f9",
            "size": payload.get("size") or "0 KB",
        })
    elif kind == "assetTagGroups":
        tags = payload.get("tags") or []
        base.update({
            "name": payload.get("name") or "��ǩ��",
            "description": payload.get("description") or "",
            "tags": [{"id": make_id("assetTagGroups"), "name": tag, "usageCount": 0} if isinstance(tag, str) else tag for tag in tags],
        })
    elif kind == "knowledgeItems":
        base.update({
            "title": payload.get("title") or "֪ʶ����",
            "source": payload.get("source") or "text",
            "url": payload.get("url") or "",
            "content": payload.get("content") or "",
            "tags": clean_strings(payload.get("tags")),
            "refreshMode": payload.get("refreshMode") or "manual",
            "status": payload.get("status") or "completed",
        })
    elif kind == "brandProfiles":
        base.update({"name": payload.get("name") or "Ʒ��", "tags": clean_strings(payload.get("tags")), "contacts": payload.get("contacts") or [], "products": payload.get("products") or []})
    elif kind == "competitorProfiles":
        base.update({"name": payload.get("name") or "��Ʒ", "tags": clean_strings(payload.get("tags")), "products": payload.get("products") or [], "strengths": payload.get("strengths") or [], "weakPoints": payload.get("weakPoints") or [], "relation": payload.get("relation") or "functional"})
    elif kind == "watermarks":
        base.update({"name": payload.get("name") or "ˮӡ", "enabled": payload.get("enabled", True), "previewUrl": payload.get("previewUrl") or "", "position": payload.get("position") or "bottom-right"})
    elif kind == "generationRules":
        base.update({"name": payload.get("name") or "���ɹ���", "type": payload.get("type") or "article", "content": payload.get("content") or "", "status": payload.get("status") or "active"})
    elif kind == "articleTypes":
        base.update({"name": payload.get("name") or "��������", "category": payload.get("category") or "�Զ���", "sourceType": payload.get("sourceType") or "custom", "visible": payload.get("visible", True), "prompt": payload.get("prompt") or "", "useCount": int(payload.get("useCount") or 0)})
    elif kind == "mediaAccounts":
        base.update({"name": payload.get("name") or "ý���˺�", "platform": payload.get("platform") or "other", "status": payload.get("status") or "pending", "cookies": payload.get("cookies") or "", "fields": payload.get("fields") or [], "lastCheckedAt": payload.get("lastCheckedAt") or "", "lastError": payload.get("lastError") or ""})
    elif kind == "mediaResources":
        base.update({"name": payload.get("name") or "ý����Դ", "industry": payload.get("industry") or "", "channelType": payload.get("channelType") or "����ý��", "comprehensivePortal": payload.get("comprehensivePortal") or "", "price": payload.get("price") or 0, "inclusionRate": payload.get("inclusionRate") or 0})
    elif kind == "keywords":
        base.update({"word": payload.get("word") or payload.get("keyword") or label, "searchVolume": int(payload.get("searchVolume") or 0), "difficulty": int(payload.get("difficulty") or 0), "intent": payload.get("intent") or ""})
    elif kind == "serpAnalyses":
        base.update({"keyword": payload.get("keyword") or label, "relatedQuestions": payload.get("relatedQuestions") or [], "contentGaps": payload.get("contentGaps") or [], "createdAt": base["createdAt"]})
    elif kind == "rankingEntries":
        base.update({"keyword": payload.get("keyword") or label, "url": payload.get("url") or "", "rank": int(payload.get("rank") or 0), "updatedAt": base["updatedAt"]})
    elif kind == "competitors":
        base.update({"name": payload.get("name") or "��Ʒ", "domain": payload.get("domain") or "", "visibility": payload.get("visibility") or 0})
    return base


def create_generic(db: Session, kind: str, payload: dict) -> dict:
    if kind == "articles":
        return create_article(db, payload)
    if kind == "sites":
        return create_site(db, payload)
    return save_record(db, kind, default_by_kind(kind, payload))


DEFAULT_ARTICLE_TYPES: list[dict[str, Any]] = [
    {
        "id": "article-type-guide",
        "name": "操作指南",
        "category": "系统预设",
        "sourceType": "system",
        "visible": True,
        "prompt": "面向搜索用户解释步骤、注意事项和执行清单，输出 H2/H3 层级、FAQ 和可引用结论。",
        "matchingRules": "适合怎么做、如何配置、流程教程、排查清单类关键词。",
        "readingRules": "先读取 SERP 中的步骤型内容和常见问题，再判断用户最需要的执行路径。",
        "outlineRules": "按背景、准备、步骤、检查、FAQ、后续动作组织。",
        "titleRules": "标题包含主关键词和明确收益，避免空泛营销词。",
        "descriptionRules": "描述需要说明适用对象、核心步骤和结果。",
        "writingRules": "每个步骤要给出动作、判断标准和常见错误。",
        "rewriteRules": "保留关键实体和工具名，压缩重复段落。",
        "notes": "默认用于 AI 创作和 SERP 创作。",
        "useCount": 0,
    },
    {
        "id": "article-type-list",
        "name": "列表文章",
        "category": "系统预设",
        "sourceType": "system",
        "visible": True,
        "prompt": "将解决方案拆成可扫描的清单，适合关键词覆盖、媒体分发和对比型内容。",
        "matchingRules": "适合工具推荐、方法合集、平台对比、最佳实践类关键词。",
        "readingRules": "读取竞品列表项、筛选维度和缺口，避免只堆名称。",
        "outlineRules": "先给选择标准，再列清单项，最后给决策建议。",
        "titleRules": "标题包含数量、场景和主关键词。",
        "descriptionRules": "描述突出清单覆盖范围和选择标准。",
        "writingRules": "每个列表项包含适用场景、优势、限制和下一步。",
        "rewriteRules": "合并相似项，保持排序逻辑清楚。",
        "useCount": 0,
    },
    {
        "id": "article-type-faq",
        "name": "GEO 引用友好 FAQ",
        "category": "GEO",
        "sourceType": "system",
        "visible": True,
        "prompt": "围绕 AI 问答场景生成问题、短答案和引用来源，强调品牌实体和可摘录句。",
        "matchingRules": "适合为什么、是什么、区别、是否值得、怎么判断类问题。",
        "readingRules": "优先读取相关问题、AI 引用源和品牌/竞品实体。",
        "outlineRules": "每个 H3 是一个真实问题，答案第一句先给结论。",
        "titleRules": "标题用问句或问题集合表达。",
        "descriptionRules": "描述要覆盖核心问题和答案边界。",
        "writingRules": "先短答，再解释依据，最后给可执行建议。",
        "rewriteRules": "保持答案直接，减少长铺垫。",
        "notes": "用于自动 GEO 和 AI 引用优化。",
        "useCount": 0,
    },
]

DEFAULT_GENERATION_RULES: list[dict[str, Any]] = [
    {
        "id": "rule-system-default",
        "name": "系统默认文章规则",
        "type": "article",
        "content": "H2/H3 结构、FAQ、可执行结论、避免空泛营销词",
        "sourceMode": "manual-keywords",
        "keywordPickMode": "manual",
        "keywordCount": 5,
        "contentRequirements": "每个 H2 后给出一句可被引用的结论；正文覆盖定义、方法、案例和 FAQ。",
        "humanizationRules": "语气像懂业务的运营顾问，少用夸张营销词。",
        "replacementRules": "将“颠覆式、赋能、下一代”等词替换为可验证描述。",
        "imageStrategy": "cover-and-inline",
        "geoStrategy": {
            "includeFaq": True,
            "includeCitationSummary": True,
            "trackBrandMention": True,
            "trackCompetitorMention": False,
        },
        "formatRules": "包含摘要、H2/H3、FAQ 和 Meta 描述。",
        "structureRules": "先讲问题，再讲方法，最后给执行清单。",
        "modelProvider": "DeepSeek",
        "status": "active",
    },
    {
        "id": "rule-system-image-text",
        "name": "系统默认图文规则",
        "type": "image-text",
        "content": "短段落、封面+插图、适合媒体分发",
        "sourceMode": "manual-keywords",
        "keywordPickMode": "manual",
        "keywordCount": 3,
        "contentRequirements": "标题不超过 28 个汉字，段落短，适合配图阅读。",
        "humanizationRules": "资讯稿口吻，减少第一人称。",
        "imageStrategy": "cover-and-inline",
        "formatRules": "封面、摘要、正文分段。",
        "structureRules": "背景、问题、方案、行动建议。",
        "modelProvider": "DeepSeek",
        "status": "active",
    },
]


def owner_scoped_writer_default(item: dict[str, Any]) -> dict[str, Any]:
    owner_id = current_owner_id()
    if not owner_id:
        return dict(item)
    template_id = str(item["id"])
    owner_suffix = uuid5(NAMESPACE_URL, owner_id).hex[:12]
    return {**item, "id": f"{template_id}-{owner_suffix}", "systemTemplateId": template_id}


def ensure_writer_defaults(db: Session) -> dict[str, int]:
    """Idempotently seed system article types and generation rules for empty libraries."""
    created_types = 0
    created_rules = 0
    stamp = now_stamp()
    for item in (owner_scoped_writer_default(template) for template in DEFAULT_ARTICLE_TYPES):
        if find_record(db, "articleTypes", item["id"]):
            continue
        save_record(db, "articleTypes", {**item, "createdAt": stamp, "updatedAt": stamp})
        created_types += 1
    for item in (owner_scoped_writer_default(template) for template in DEFAULT_GENERATION_RULES):
        if find_record(db, "generationRules", item["id"]):
            continue
        save_record(db, "generationRules", {**item, "createdAt": stamp, "updatedAt": stamp})
        created_rules += 1
    # Also seed by name if IDs were wiped but names remain empty library UX
    if not list_records(db, "articleTypes"):
        for item in (owner_scoped_writer_default(template) for template in DEFAULT_ARTICLE_TYPES):
            save_record(db, "articleTypes", {**item, "createdAt": stamp, "updatedAt": stamp})
            created_types += 1
    if not list_records(db, "generationRules"):
        for item in (owner_scoped_writer_default(template) for template in DEFAULT_GENERATION_RULES):
            save_record(db, "generationRules", {**item, "createdAt": stamp, "updatedAt": stamp})
            created_rules += 1
    return {"articleTypes": created_types, "generationRules": created_rules}


def create_publish_job(
    db: Session,
    article: dict,
    site: dict,
    published_url: str = "",
    external_id: str = "",
    adapter_type: str = "",
    error_message: str = "",
) -> dict:
    resolved_url = str(published_url or "").strip()
    # A publish job is only successful after an adapter returns a real public URL.
    # Earlier prototypes guessed a URL from baseUrl + slug, which made unrelated pages
    # look published and broke the article -> publish -> index workflow.
    status = "succeeded" if resolved_url else ("failed" if error_message else "pending")
    job = {
        "id": make_id("publishJobs"),
        "articleId": article["id"],
        "siteId": site["id"],
        "articleTitle": article.get("title") or "δ��������",
        "siteName": site.get("name") or "δ����վ��",
        "connectorType": adapter_type or site.get("type") or site.get("siteType") or "Webhook",
        "status": status,
        "publishedUrl": resolved_url,
        "externalId": external_id,
        "errorMessage": error_message,
        "createdAt": now_stamp(),
        "updatedAt": now_stamp(),
    }
    save_record(db, "publishJobs", job)
    # Only update article status to "published" and record the URL when publishing truly succeeded.
    if resolved_url:
        patch_record(db, "articles", article["id"], {"status": "published", "publishedUrl": resolved_url, "publishStatus": "published", "updatedAt": now_stamp()})
        patch_record(db, "sites", site["id"], {"lastPublishedAt": now_stamp(), "status": "active"})
    elif status == "pending":
        patch_record(db, "articles", article["id"], {"publishStatus": "queued", "updatedAt": now_stamp()})
    return job


def create_index_submission(db: Session, payload: dict) -> dict:
    provider = payload.get("provider") or "IndexNow"
    if provider not in INDEX_PROVIDERS:
        provider = "IndexNow"
    submission = {
        "id": payload.get("id") or make_id("indexSubmissions"),
        "articleId": payload.get("articleId") or "",
        "articleTitle": payload.get("articleTitle") or "δ��������",
        "provider": provider,
        "source": payload.get("source") or "manual",
        "sourceType": payload.get("sourceType") or "manual",
        "sourceId": payload.get("sourceId") or "",
        "url": payload.get("url") or "",
        "status": payload.get("status") or "pending",
        "submitted": bool(payload.get("submitted", False)),
        "submissionMethod": payload.get("submissionMethod") or "",
        "providerMessage": payload.get("providerMessage") or "",
        "providerResponse": payload.get("providerResponse") if isinstance(payload.get("providerResponse"), dict) else {},
        "submissionReason": payload.get("submissionReason") or "",
        "inclusionStatus": payload.get("inclusionStatus") or "unchecked",
        "inspectionStatus": payload.get("inspectionStatus") or "unchecked",
        "verificationLevel": payload.get("verificationLevel") or "unavailable",
        "verificationMethod": payload.get("verificationMethod") or "",
        "inspectionMessage": payload.get("inspectionMessage") or "",
        "inspectionResponse": payload.get("inspectionResponse") if isinstance(payload.get("inspectionResponse"), dict) else {},
        "evidence": payload.get("evidence") if isinstance(payload.get("evidence"), dict) else {},
        "availabilityStatus": payload.get("availabilityStatus") or "unknown",
        "availabilityHttpStatus": payload.get("availabilityHttpStatus"),
        "availabilityError": payload.get("availabilityError") or "",
        "submittedAt": payload.get("submittedAt") or "",
        "checkedAt": payload.get("checkedAt") or "",
        "createdAt": payload.get("createdAt") or now_stamp(),
        "updatedAt": payload.get("updatedAt") or now_stamp(),
    }
    return save_record(db, "indexSubmissions", submission)


def queue_index_submission(
    db: Session,
    payload: dict,
    queue_backend: Any | None = None,
) -> dict:
    submission_id = str(payload.get("submissionId") or "").strip()
    if not submission_id and not str(payload.get("url") or "").strip():
        raise HTTPException(status_code=400, detail="INDEX_URL_REQUIRED")
    submission = (
        get_record(db, "indexSubmissions", submission_id)
        if submission_id
        else create_index_submission(db, payload)
    )
    if not str(submission.get("url") or "").strip():
        raise HTTPException(status_code=400, detail="INDEX_URL_REQUIRED")

    active_task = next((
        task for task in reversed(list_records(db, "tasks"))
        if task.get("type") == "index-submit"
        and task.get("status") in {"queued", "running", "processing", "publishing", "retry"}
        and str((task.get("payload") or {}).get("submissionId") or "") == submission["id"]
    ), None)
    if active_task:
        return patch_record(db, "indexSubmissions", submission["id"], {
            "status": "pending",
            "queued": bool((active_task.get("queueResult") or {}).get("queued", True)),
            "taskId": active_task["id"],
        })

    failed_enqueue_tasks = [
        task for task in list_records(db, "tasks")
        if task.get("type") == "index-submit"
        and task.get("status") == "pending"
        and not (task.get("queueResult") or {}).get("queued")
        and str((task.get("payload") or {}).get("submissionId") or "") == submission["id"]
    ]
    for failed_task in failed_enqueue_tasks:
        patch_record(db, "tasks", failed_task["id"], {
            "status": "failed",
            "errorMessage": failed_task.get("errorMessage") or "QUEUE_ENQUEUE_FAILED",
        })

    task = create_task(db, "index-submit", f"Submit index: {submission.get('articleTitle') or submission['id']}", {
        "submissionId": submission["id"],
        "articleId": submission.get("articleId") or "",
        "articleTitle": submission.get("articleTitle") or "",
        "provider": submission.get("provider") or "IndexNow",
        "source": submission.get("source") or "manual",
        "sourceType": submission.get("sourceType") or "manual",
        "sourceId": submission.get("sourceId") or "",
        "url": submission.get("url") or "",
        "checkImmediately": bool(payload.get("checkImmediately")),
    }, "index", queue_backend=queue_backend)
    queued = bool((task.get("queueResult") or {}).get("queued", task.get("status") == "queued"))
    return patch_record(db, "indexSubmissions", submission["id"], {
        "status": "pending",
        "submitted": False,
        "queued": queued,
        "taskId": task["id"],
    })


def submit_index_submission(db: Session, submission_id: str, index_service: Any) -> dict:
    submission = get_record(db, "indexSubmissions", submission_id)
    patch_record(db, "indexSubmissions", submission_id, {
        "status": "submitting",
        "lastSubmissionAttemptAt": now_stamp(),
        "submissionError": "",
    })
    try:
        result = index_service.submit(submission)
    except Exception as error:
        safe_error = sanitize_provider_error(error)
        patch_record(db, "indexSubmissions", submission_id, {
            "status": "failed",
            "submitted": False,
            "providerMessage": safe_error,
            "submissionError": safe_error,
        })
        audit_event(db, "index.submit_failed", "indexSubmissions", submission_id, {"error": safe_error})
        raise RuntimeError(safe_error) from None

    submitted = bool(result.get("submitted"))
    updated = patch_record(db, "indexSubmissions", submission_id, {
        "status": result.get("status") or ("accepted" if submitted else "provider_pending"),
        "submitted": submitted,
        "submissionMethod": result.get("submissionMethod") or "",
        "providerMessage": result.get("providerMessage") or "",
        "providerResponse": result.get("providerResponse") if isinstance(result.get("providerResponse"), dict) else {},
        "submissionReason": result.get("reason") or "",
        "submittedAt": now_stamp() if submitted else "",
        "queued": False,
    })
    article_id = str(updated.get("articleId") or "")
    if article_id and find_record(db, "articles", article_id):
        patch_record(db, "articles", article_id, {
            "indexStatus": "submitted" if submitted else updated.get("status") or "pending",
        })
    audit_event(db, "index.submit", "indexSubmissions", submission_id, {
        "provider": updated.get("provider"),
        "status": updated.get("status"),
        "submitted": submitted,
    })
    return updated


def normalize_legacy_index_submissions(db: Session) -> dict[str, int]:
    migrated = 0
    for submission in list_records(db, "indexSubmissions"):
        inclusion_status = str(submission.get("inclusionStatus") or "unchecked")
        verification_level = str(submission.get("verificationLevel") or "")
        verification_method = str(submission.get("verificationMethod") or "")
        legacy_submission_status = str(submission.get("status") or "")
        synthetic_submission = (
            legacy_submission_status == "submitted"
            and submission.get("submitted") is not True
            and not submission.get("submissionMethod")
            and not submission.get("providerResponse")
        )
        synthetic_inclusion = inclusion_status in {"indexed", "not_indexed", "failed"}
        if not synthetic_submission and not synthetic_inclusion:
            continue
        if verification_level in {"official", "observed"}:
            continue
        if verification_method and verification_method not in {"http", "local_http", "legacy_http_availability"}:
            continue
        patch_record(db, "indexSubmissions", submission["id"], {
            "status": "unverified",
            "submitted": False,
            "inclusionStatus": "unchecked",
            "inspectionStatus": "unverified",
            "verificationLevel": "unavailable",
            "verificationMethod": "legacy_http_availability",
            "legacyInclusionStatus": inclusion_status,
            "legacySubmissionStatus": legacy_submission_status,
            "inspectionMessage": "�ɼ�¼��������ҳ�ɷ������жϣ��ѳ�����¼���ۣ�������ִ������������֤��",
        })
        migrated += 1
    return {"migrated": migrated}


def create_task(
    db: Session,
    task_type: str,
    title: str,
    payload: dict,
    queue: str = "default",
    status: str | None = None,
    error_message: str = "",
    queue_backend: Any | None = None,
) -> dict:
    task = {
        "id": make_id("tasks"),
        "type": task_type,
        "title": title,
        "status": status or "queued",
        "progress": 0,
        "queue": queue,
        "payload": payload,
        "retryCount": int(payload.get("retryCount") or 0) if isinstance(payload, dict) else 0,
        "errorMessage": error_message,
        "createdAt": now_stamp(),
        "updatedAt": now_stamp(),
    }
    saved = save_record(db, "tasks", task)
    log_task_event(db, saved["id"], "task.created", f"Task created: {title}", detail={"queue": queue, "type": task_type})
    audit_event(db, "task.create", "tasks", saved["id"], {"type": task_type, "queue": queue})
    backend = queue_backend or queue_client
    queue_result = backend.enqueue(queue, {"taskId": saved["id"], "type": task_type, "payload": payload, "ownerId": saved["ownerId"]})
    patch = {"queueResult": queue_result}
    if not queue_result.get("queued"):
        patch["status"] = "pending"
        patch["errorMessage"] = queue_result.get("error", "")
    return patch_record(db, "tasks", saved["id"], patch)


def retry_task(db: Session, task_id: str) -> dict:
    task = get_record(db, "tasks", task_id)
    if task.get("queueTerminal"):
        raise HTTPException(status_code=409, detail="QUEUE_TERMINAL_RETRY_REQUIRES_MANUAL_REVIEW")
    retry_count = int(task.get("retryCount") or 0) + 1
    queue = task.get("queue") or "default"
    payload = task.get("payload") or {}
    queue_result = queue_client.enqueue(queue, {"taskId": task["id"], "type": task.get("type"), "payload": payload, "retryCount": retry_count, "ownerId": task.get("ownerId")})
    status = "queued" if queue_result.get("queued") else "pending"
    updated = patch_record(db, "tasks", task_id, {
        "status": status,
        "retryCount": retry_count,
        "queueResult": queue_result,
        "errorMessage": "" if queue_result.get("queued") else queue_result.get("error", task.get("errorMessage", "")),
    })
    log_task_event(db, task_id, "task.retry", f"Task retry #{retry_count}", detail={"queueResult": queue_result})
    audit_event(db, "task.retry", "tasks", task_id, {"retryCount": retry_count, "queue": queue})
    return updated


def create_notification(db: Session, title: str, message: str, level: str = "info", target: dict | None = None) -> dict:
    normalized_target = target if isinstance(target, dict) else {}
    return save_record(db, "notifications", normalize_notification({
        "id": make_id("notifications"),
        "title": title,
        "message": message,
        "level": level,
        "target": normalized_target,
        "read": False,
        "createdAt": now_stamp(),
    }))


def notification_href(target: dict) -> str:
    if target.get("href"):
        return str(target["href"])
    if target.get("articleId"):
        return f"/editor?articleId={target['articleId']}"
    if target.get("knowledgeId"):
        return f"/ai-writer/knowledge?knowledgeId={target['knowledgeId']}"
    if target.get("mediaOrderId"):
        return "/published"
    if target.get("indexSubmissionId"):
        return "/published"
    if target.get("llmRequestId"):
        return f"/articles/history?requestId={target['llmRequestId']}"
    if target.get("taskId"):
        return "/dashboard"
    return "/dashboard"


def normalize_notification(notification: dict) -> dict:
    target = notification.get("target") if isinstance(notification.get("target"), dict) else {}
    read = bool(notification.get("read"))
    return {
        **notification,
        "title": notification.get("title") or "ϵͳ֪ͨ",
        "message": notification.get("message") or "",
        "level": notification.get("level") or "info",
        "target": target,
        "read": read,
        "readAt": notification.get("readAt") or "",
        "href": notification_href(target),
        "createdAt": notification.get("createdAt") or now_stamp(),
    }


def list_notifications(db: Session) -> list[dict]:
    return [normalize_notification(item) for item in list_records(db, "notifications")]


def create_notification_from_payload(db: Session, payload: dict) -> dict:
    return create_notification(
        db,
        str(payload.get("title") or "ϵͳ֪ͨ"),
        str(payload.get("message") or ""),
        str(payload.get("level") or "info"),
        payload.get("target") if isinstance(payload.get("target"), dict) else {},
    )


def mark_notification_read(db: Session, notification_id: str, read: bool) -> dict:
    patch = {"read": read, "readAt": now_stamp() if read else ""}
    return normalize_notification(patch_record(db, "notifications", notification_id, patch))


def batch_mark_notifications(db: Session, payload: dict) -> dict:
    scope = str(payload.get("scope") or "selected")
    read = bool(payload.get("read"))
    ids = set(clean_strings(payload.get("ids")))
    candidates = list_notifications(db)
    if scope != "all":
        candidates = [item for item in candidates if item.get("id") in ids]
    updated = [mark_notification_read(db, item["id"], read) for item in candidates]
    audit_event(db, "notifications.batch_mark", "notifications", scope, {"count": len(updated), "read": read})
    return {"updated": len(updated), "records": updated}


DEFAULT_SEO_CAPABILITIES = ["keyword-discover", "serp-collect", "geo-collect", "ranking-check"]


def mask_secret(value: str) -> str:
    if not value:
        return ""
    if len(value) <= 4:
        return "*" * len(value)
    return f"{value[:3]}{'*' * max(len(value) - 4, 1)}{value[-1]}"


def public_seo_provider_config(config: dict) -> dict:
    api_key = str(config.get("apiKey") or "")
    public = {key: value for key, value in config.items() if key != "apiKey"}
    public["apiKeyMasked"] = mask_secret(api_key)
    public["hasApiKey"] = bool(api_key)
    public["capabilities"] = clean_strings(public.get("capabilities")) or DEFAULT_SEO_CAPABILITIES
    public["enabled"] = bool(public.get("enabled", True))
    public["status"] = public.get("status") or ("configured" if public.get("baseUrl") else "provider_pending")
    return public


def create_seo_provider_config(db: Session, payload: dict) -> dict:
    now = now_stamp()
    config = {
        "id": payload.get("id") or make_id("seoProviderConfigs"),
        "name": payload.get("name") or "SEO Provider",
        "provider": payload.get("provider") or "custom-provider",
        "baseUrl": str(payload.get("baseUrl") or "").strip().rstrip("/"),
        "apiKey": str(payload.get("apiKey") or "").strip(),
        "capabilities": clean_strings(payload.get("capabilities")) or DEFAULT_SEO_CAPABILITIES,
        "enabled": bool(payload.get("enabled", True)),
        "status": payload.get("status") or ("configured" if payload.get("baseUrl") else "provider_pending"),
        "lastHealthCheck": payload.get("lastHealthCheck") if isinstance(payload.get("lastHealthCheck"), dict) else {},
        "createdAt": payload.get("createdAt") or now,
        "updatedAt": now,
    }
    saved = save_record(db, "seoProviderConfigs", config)
    audit_event(db, "seo_provider.config_save", "seoProviderConfigs", saved["id"], {"provider": saved.get("provider"), "enabled": saved.get("enabled")})
    return public_seo_provider_config(saved)


def list_seo_provider_configs(db: Session) -> list[dict]:
    return [public_seo_provider_config(item) for item in list_records(db, "seoProviderConfigs")]


def patch_seo_provider_config(db: Session, config_id: str, payload: dict) -> dict:
    current = get_record(db, "seoProviderConfigs", config_id)
    patch = dict(payload)
    if "baseUrl" in patch:
        patch["baseUrl"] = str(patch.get("baseUrl") or "").strip().rstrip("/")
    if "capabilities" in patch:
        patch["capabilities"] = clean_strings(patch.get("capabilities")) or DEFAULT_SEO_CAPABILITIES
    if "apiKey" in patch:
        patch["apiKey"] = str(patch.get("apiKey") or "").strip()
    updated = patch_record(db, "seoProviderConfigs", config_id, patch)
    audit_event(db, "seo_provider.config_update", "seoProviderConfigs", config_id, {"changedFields": sorted(patch.keys())})
    return public_seo_provider_config(updated)


def health_check_seo_provider_config(db: Session, config_id: str) -> dict:
    config = get_record(db, "seoProviderConfigs", config_id)
    now = now_stamp()
    configured = bool(config.get("baseUrl")) and bool(config.get("enabled", True))
    status = "connected" if configured else "provider_pending"
    message = "SEO provider configuration is ready." if configured else "SEO provider base URL is not configured or provider is disabled."
    request_payload = {
        "baseUrl": config.get("baseUrl") or "",
        "provider": config.get("provider") or "custom-provider",
        "capabilities": clean_strings(config.get("capabilities")) or DEFAULT_SEO_CAPABILITIES,
    }
    result = save_record(db, "seoProviderResults", {
        "id": make_id("seoProviderResults"),
        "taskId": "",
        "taskType": "provider-health-check",
        "recordKind": "seoProviderConfigs",
        "sourceRecordId": config_id,
        "provider": config.get("provider") or "custom-provider",
        "status": status,
        "requestPayload": request_payload,
        "response": {
            "ok": configured,
            "message": message,
            "checkedAt": now,
            "capabilities": request_payload["capabilities"],
        },
        "createdAt": now,
        "updatedAt": now,
    })
    updated = patch_record(db, "seoProviderConfigs", config_id, {
        "status": status,
        "lastHealthCheck": {
            "ok": configured,
            "status": status,
            "message": message,
            "checkedAt": now,
            "resultId": result["id"],
        },
    })
    audit_event(db, "seo_provider.health_check", "seoProviderConfigs", config_id, {"status": status, "resultId": result["id"]})
    create_notification(
        db,
        "SEO Provider connected" if configured else "SEO Provider needs configuration",
        message,
        "success" if configured else "warning",
        {"seoProviderConfigId": config_id, "seoProviderResultId": result["id"], "href": "/dashboard"},
    )
    return {"config": public_seo_provider_config(updated), "result": result}


def failure_center_records(db: Session) -> list[dict]:
    logs = list_records(db, "taskLogs")
    notifications = list_records(db, "notifications")
    records = []
    for task in list_records(db, "tasks"):
        status = task.get("status")
        if status not in {"failed", "pending"} and not task.get("errorMessage"):
            continue
        task_logs = [item for item in logs if item.get("taskId") == task.get("id")]
        task_notifications = [
            item for item in notifications
            if isinstance(item.get("target"), dict) and item["target"].get("taskId") == task.get("id")
        ]
        retry_count = int(task.get("retryCount") or 0)
        records.append({
            **task,
            "logs": task_logs[-5:],
            "notifications": task_notifications[-3:],
            "retryable": retry_count < int(task.get("retryLimit") or 3),
            "lastError": {
                "message": task.get("errorMessage") or (task_logs[-1].get("message") if task_logs else ""),
                "at": task.get("updatedAt") or task.get("createdAt") or "",
            },
        })
    return sorted(records, key=lambda item: sortable_timestamp(item.get("updatedAt") or item.get("createdAt")), reverse=True)


def failure_center(db: Session) -> dict:
    records = failure_center_records(db)
    return {
        "records": records,
        "summary": {
            "failed": sum(1 for item in records if item.get("status") == "failed"),
            "pending": sum(1 for item in records if item.get("status") == "pending"),
            "retryable": sum(1 for item in records if item.get("retryable")),
            "blocked": sum(1 for item in records if not item.get("retryable")),
        },
    }


def failure_detail(db: Session, task_id: str) -> dict:
    task = get_record(db, "tasks", task_id)
    logs = [item for item in list_records(db, "taskLogs") if item.get("taskId") == task_id]
    llm_requests = [item for item in list_records(db, "llmRequests") if item.get("taskId") == task_id]
    audit_logs = [
        item for item in list_records(db, "auditLogs")
        if item.get("targetId") == task_id or (isinstance(item.get("detail"), dict) and item["detail"].get("taskId") == task_id)
    ]
    provider_results = [
        item for item in list_records(db, "seoProviderResults")
        if item.get("taskId") == task_id
        or (isinstance(item.get("requestPayload"), dict) and item["requestPayload"].get("taskId") == task_id)
        or item.get("sourceRecordId") == (task.get("payload") if isinstance(task.get("payload"), dict) else {}).get("recordId")
    ]
    notifications = [
        item for item in list_records(db, "notifications")
        if isinstance(item.get("target"), dict) and item["target"].get("taskId") == task_id
    ]
    retry_count = int(task.get("retryCount") or 0)
    return {
        "task": task,
        "logs": logs,
        "llmRequests": llm_requests,
        "auditLogs": audit_logs,
        "providerResults": provider_results,
        "queueResult": task.get("queueResult") or {},
        "notifications": notifications,
        "lastError": {
            "message": task.get("errorMessage") or (logs[-1].get("message") if logs else ""),
            "at": task.get("updatedAt") or task.get("createdAt") or "",
        },
        "nextActions": [
            {"action": "retry", "enabled": retry_count < int(task.get("retryLimit") or 3)},
            {"action": "view-logs", "enabled": bool(logs)},
            {"action": "view-llm-request", "enabled": bool(llm_requests)},
            {"action": "view-provider-result", "enabled": bool(provider_results)},
            {"action": "view-audit", "enabled": bool(audit_logs)},
        ],
    }


def retry_failed_task(db: Session, task_id: str) -> dict:
    task = retry_task(db, task_id)
    notification = create_notification(
        db,
        "Task retry queued",
        f"Retry #{task.get('retryCount')} queued for {task.get('title') or task.get('type')}.",
        "info",
        {"type": "task", "taskId": task_id, "status": task.get("status")},
    )
    return {"task": task, "notification": notification}


def cosine_similarity(left: list[float], right: list[float]) -> float:
    if not left or not right:
        return 0.0
    size = min(len(left), len(right))
    dot = sum(float(left[index]) * float(right[index]) for index in range(size))
    left_norm = sum(float(left[index]) ** 2 for index in range(size)) ** 0.5
    right_norm = sum(float(right[index]) ** 2 for index in range(size)) ** 0.5
    if not left_norm or not right_norm:
        return 0.0
    return dot / (left_norm * right_norm)


def search_knowledge_chunks(db: Session, payload: dict) -> dict:
    query = str(payload.get("query") or "").strip()
    if not query:
        raise HTTPException(status_code=400, detail="QUERY_REQUIRED")
    top_k = max(1, min(20, int(payload.get("topK") or payload.get("limit") or 5)))
    filter_tags = {str(item).strip().lower() for item in payload.get("tags") or [] if str(item).strip()}
    filter_knowledge_ids = {str(item) for item in payload.get("knowledgeIds") or [] if str(item)}
    query_vector = deterministic_embedding(query)
    query_terms = {term.lower() for term in re.findall(r"[\w\u4e00-\u9fff]+", query)}
    knowledge_by_id = {item["id"]: item for item in list_records(db, "knowledgeItems")}
    vectors_by_chunk_id = {item.get("chunkId"): item for item in list_records(db, "knowledgeVectors")}
    records = []
    for chunk in list_records(db, "knowledgeChunks"):
        knowledge_id = str(chunk.get("knowledgeId") or "")
        knowledge = knowledge_by_id.get(knowledge_id)
        if not knowledge:
            continue
        if filter_knowledge_ids and knowledge_id not in filter_knowledge_ids:
            continue
        knowledge_tags = {str(tag).strip().lower() for tag in knowledge.get("tags") or [] if str(tag).strip()}
        if filter_tags and not filter_tags.issubset(knowledge_tags):
            continue
        content = str(chunk.get("content") or "")
        vector = vectors_by_chunk_id.get(chunk.get("id"), {}).get("embedding") or deterministic_embedding(content)
        vector_score = cosine_similarity(query_vector, vector if isinstance(vector, list) else [])
        content_terms = {term.lower() for term in re.findall(r"[\w\u4e00-\u9fff]+", content)}
        keyword_score = len(query_terms & content_terms) / max(1, len(query_terms))
        score = round((vector_score * 0.65) + (keyword_score * 0.35), 6)
        records.append({
            "chunkId": chunk.get("id"),
            "knowledgeId": knowledge_id,
            "knowledgeTitle": knowledge.get("title") or "",
            "index": chunk.get("index", 0),
            "content": content,
            "score": score,
            "vectorScore": round(vector_score, 6),
            "keywordScore": round(keyword_score, 6),
            "tags": list(knowledge.get("tags") or []),
        })
    records.sort(key=lambda item: item["score"], reverse=True)
    return {"query": query, "total": len(records[:top_k]), "records": records[:top_k]}


def build_writer_context(db: Session, payload: dict) -> dict:
    writer_context = payload.get("writerContext") if isinstance(payload.get("writerContext"), dict) else {}
    knowledge_ids = payload.get("knowledgeIds") or writer_context.get("knowledgeItemIds") or writer_context.get("knowledgeIds") or []
    asset_ids = payload.get("assetIds") or writer_context.get("assetIds") or []
    brand_ids = payload.get("brandProfileIds") or writer_context.get("brandProfileIds") or []
    competitor_ids = payload.get("competitorProfileIds") or writer_context.get("competitorProfileIds") or []
    rule = find_record(db, "generationRules", str(payload.get("ruleId") or "")) if payload.get("ruleId") else None
    knowledge_items = [item for item in (find_record(db, "knowledgeItems", str(item_id)) for item_id in knowledge_ids) if item]
    assets = [item for item in (find_record(db, "assets", str(item_id)) for item_id in asset_ids) if item]
    all_brand_profiles = list_records(db, "brandProfiles")
    all_competitors = list_records(db, "competitorProfiles")
    brand_profiles = [item for item in all_brand_profiles if item.get("id") in brand_ids] if brand_ids else all_brand_profiles[:5]
    competitors = [item for item in all_competitors if item.get("id") in competitor_ids] if competitor_ids else all_competitors[:5]
    keyword = payload.get("keyword") or payload.get("primaryKeyword") or payload.get("title") or "AI SEO"
    retrieved_chunks = search_knowledge_chunks(db, {
        "query": payload.get("knowledgeQuery") or keyword,
        "knowledgeIds": knowledge_ids,
        "tags": payload.get("knowledgeTags") or [],
        "topK": payload.get("knowledgeTopK") or 5,
    })["records"] if list_records(db, "knowledgeChunks") else []
    return {
        **payload,
        **writer_context,
        "keyword": keyword,
        "rule": rule,
        "knowledgeItems": knowledge_items,
        "knowledgeChunks": retrieved_chunks,
        "assets": assets,
        "brandProfiles": brand_profiles,
        "competitorProfiles": competitors,
    }


def summarize_writer_context(context: dict) -> dict:
    rule = context.get("rule") if isinstance(context.get("rule"), dict) else {}
    return {
        "keyword": context.get("keyword") or context.get("primaryKeyword") or context.get("title") or "",
        "ruleId": rule.get("id") or context.get("ruleId") or "",
        "ruleName": rule.get("name") or context.get("ruleName") or "",
        "knowledgeItemIds": [item.get("id") for item in context.get("knowledgeItems") or [] if isinstance(item, dict) and item.get("id")],
        "assetIds": [item.get("id") for item in context.get("assets") or [] if isinstance(item, dict) and item.get("id")],
        "brandProfileIds": [item.get("id") for item in context.get("brandProfiles") or [] if isinstance(item, dict) and item.get("id")],
        "competitorProfileIds": [item.get("id") for item in context.get("competitorProfiles") or [] if isinstance(item, dict) and item.get("id")],
    }


def summarize_llm_output(output: dict) -> dict:
    return {
        "title": output.get("title") or "",
        "summary": output.get("summary") or "",
        "metaDescription": output.get("metaDescription") or "",
        "keywords": clean_strings(output.get("keywords")),
        "tags": clean_strings(output.get("tags")),
        "contentPreview": str(output.get("contentMarkdown") or "")[:500],
    }


def create_llm_request_record(
    db: Session,
    context: dict,
    request_payload: dict,
    output: dict,
    article_id: str = "",
    task_id: str = "",
    status: str = "succeeded",
    error_message: str = "",
    provider: str = "deepseek",
    normalized_output: dict | None = None,
) -> dict:
    settings = get_settings()
    record = {
        "id": make_id("llmRequests"),
        "provider": provider,
        "model": request_payload.get("model") or (settings.gemini_text_model if provider == "gemini" else settings.deepseek_model),
        "status": status,
        "articleId": article_id,
        "taskId": task_id,
        "contextSummary": summarize_writer_context(context),
        "requestPayload": request_payload,
        "responseSummary": summarize_llm_output(output),
        "normalizedResponseSummary": summarize_llm_output(normalized_output or output),
        "errorMessage": error_message,
        "createdAt": now_stamp(),
        "updatedAt": now_stamp(),
    }
    saved = save_record(db, "llmRequests", record)
    audit_event(db, "llm.request", "llmRequests", saved["id"], {
        "provider": saved["provider"],
        "model": saved["model"],
        "status": saved["status"],
        "articleId": article_id,
        "taskId": task_id,
        "contextSummary": saved["contextSummary"],
    })
    return saved


def create_ai_article(
    db: Session,
    payload: dict,
    llm_output: dict,
    context: dict,
    create_generation_task: bool = True,
    task_id: str = "",
    request_payload: dict | None = None,
    provider: str = "deepseek",
    audit_output: dict | None = None,
) -> dict:
    article = create_article(db, {
        **payload,
        **llm_output,
        "status": payload.get("status") or "ready",
        "source": f"{provider}_ai",
        "llmProvider": provider,
        "llmModel": payload.get("model") or (get_settings().gemini_text_model if provider == "gemini" else get_settings().deepseek_model),
        "writerContext": context,
        "ruleId": (context.get("rule") or {}).get("id") if isinstance(context.get("rule"), dict) else payload.get("ruleId", ""),
        "ruleName": (context.get("rule") or {}).get("name") if isinstance(context.get("rule"), dict) else payload.get("ruleName", ""),
    })
    generation_task_id = task_id
    if create_generation_task:
        task = create_task(db, "ai-generate-article", f"AI article generation: {article['title']}", {"articleId": article["id"], "context": context}, "ai")
        generation_task_id = task["id"]
        log_task_event(db, generation_task_id, "article.generated", "Article generated with DeepSeek context", detail={"articleId": article["id"]})
    if request_payload:
        create_llm_request_record(
            db,
            context,
            request_payload,
            audit_output or llm_output,
            article["id"],
            generation_task_id,
            provider=provider,
            normalized_output=llm_output,
        )
    audit_event(db, "article.generate", "articles", article["id"], {"taskId": generation_task_id, "provider": provider})
    return article


def persist_knowledge_analysis(db: Session, item: dict, text: str, task: dict, chunks: list[dict], vectors: list[dict]) -> dict:
    for chunk in chunks:
        save_record(db, "knowledgeChunks", {**chunk, "createdAt": now_stamp(), "updatedAt": now_stamp()})
    for vector in vectors:
        save_record(db, "knowledgeVectors", {**vector, "createdAt": now_stamp(), "updatedAt": now_stamp()})
    updated = save_record(db, "knowledgeItems", {
        **item,
        "content": text,
        "status": "completed",
        "chunkCount": len(chunks),
        "vectorCount": len(vectors),
        "taskId": task["id"],
        "updatedAt": now_stamp(),
    })
    log_task_event(db, task["id"], "knowledge.parsed", "Knowledge source parsed and vectorized", detail={"chunkCount": len(chunks), "vectorCount": len(vectors)})
    audit_event(db, "knowledge.parse", "knowledgeItems", updated["id"], {"taskId": task["id"], "chunkCount": len(chunks)})
    return updated


def check_submission(db: Session, submission_id: str, index_service: Any) -> dict:
    submission = get_record(db, "indexSubmissions", submission_id)
    url = str(submission.get("url") or "")
    patch_record(db, "indexSubmissions", submission_id, {
        "inclusionStatus": "checking",
        "inspectionStatus": "checking",
        "inspectionError": "",
    })
    availability = index_service.check_availability(url)
    try:
        result = index_service.inspect(submission)
    except Exception as error:
        safe_error = sanitize_provider_error(error)
        patch_record(db, "indexSubmissions", submission_id, {
            **availability,
            "inclusionStatus": "failed",
            "inspectionStatus": "failed",
            "verificationLevel": "unavailable",
            "verificationMethod": "provider_error",
            "inspectionMessage": safe_error,
            "inspectionError": safe_error,
            "checkedAt": now_stamp(),
        })
        audit_event(db, "index.inspect_failed", "indexSubmissions", submission_id, {"error": safe_error})
        raise RuntimeError(safe_error) from None

    patch = {
        **availability,
        "inclusionStatus": result.get("inclusionStatus") or "unchecked",
        "inspectionStatus": result.get("status") or "verified",
        "verificationLevel": result.get("verificationLevel") or "unavailable",
        "verificationMethod": result.get("verificationMethod") or "provider_unavailable",
        "inspectionMessage": result.get("providerMessage") or "",
        "inspectionResponse": result.get("providerResponse") if isinstance(result.get("providerResponse"), dict) else {},
        "evidence": result.get("evidence") if isinstance(result.get("evidence"), dict) else {},
        "inspectionReason": result.get("reason") or "",
        "checkedAt": now_stamp(),
    }
    updated = patch_record(db, "indexSubmissions", submission_id, patch)
    audit_event(db, "index.inspect", "indexSubmissions", submission_id, {
        "provider": updated.get("provider"),
        "inclusionStatus": updated.get("inclusionStatus"),
        "verificationLevel": updated.get("verificationLevel"),
    })
    return updated


ARTICLE_RETRYABLE_PUBLISH_STATUSES = {"", "not_published", "failed", "canceled", "cancelled"}
ARTICLE_COMPLETED_PUBLISH_STATUSES = {"published", "succeeded", "archived"}
MEDIA_ORDER_RETRYABLE_STATUSES = {"", "not_published", "failed", "canceled", "cancelled"}


def article_publish_state(article: dict | None) -> str:
    """Return the single article-level publication state used by every channel."""
    if not isinstance(article, dict):
        return "not_published"
    status = str(article.get("status") or "").strip().lower()
    if status in {"published", "archived"}:
        return status
    if str(article.get("publishedUrl") or article.get("mediaPublishedUrl") or "").strip():
        return "published"
    for field in ("publishStatus", "publicationStatus", "mediaPublishStatus"):
        value = str(article.get(field) or "").strip().lower()
        if value:
            return value
    return "not_published"


def article_is_locked_after_publish(article: dict | None) -> bool:
    """An article stays occupied from queueing until explicit failure/cancellation."""
    return article_publish_state(article) not in ARTICLE_RETRYABLE_PUBLISH_STATUSES


def claim_article_publish(db: Session, article_id: str) -> dict:
    """Atomically claim an article so concurrent publish requests cannot both queue."""
    row = db.scalar(
        select(Record)
        .where(Record.id == article_id, Record.kind == "articles")
        .with_for_update()
    )
    if not row:
        raise HTTPException(status_code=404, detail="ARTICLES_NOT_FOUND")
    article = dict(row.data)
    assert_article_editable(article, action="publish")
    updated = {
        **article,
        "publishStatus": "pending",
        "publicationStatus": "pending",
        "updatedAt": now_stamp(),
    }
    row.data = updated
    db.commit()
    return updated


def assert_article_editable(article: dict | None, *, action: str = "edit") -> None:
    if not article_is_locked_after_publish(article):
        return
    publish_state = article_publish_state(article)
    if action == "publish" and publish_state in ARTICLE_COMPLETED_PUBLISH_STATUSES:
        detail: str | dict = "ARTICLE_ALREADY_PUBLISHED"
    elif action == "publish":
        detail = {
            "code": "ARTICLE_PUBLISH_ALREADY_ACTIVE",
            "message": "该文章已有发布流程。排队、发布中或平台审核中都不能再次发布，只有明确失败后才能重试。",
            "articleId": str(article.get("id") or "") if isinstance(article, dict) else "",
            "publishStatus": publish_state,
        }
    else:
        detail = "ARTICLE_PUBLISHED_LOCKED"
    raise HTTPException(status_code=409, detail=detail)


def media_order_is_retryable(order: dict | None) -> bool:
    return str((order or {}).get("status") or "").strip().lower() in MEDIA_ORDER_RETRYABLE_STATUSES


def active_media_order_for_article_account(
    db: Session,
    article_id: str,
    account_id: str,
    *,
    exclude_order_id: str = "",
) -> dict | None:
    for order in reversed(list_records(db, "mediaOrders")):
        if str(order.get("id") or "") == exclude_order_id:
            continue
        if str(order.get("articleId") or "") != article_id:
            continue
        if str(order.get("mediaAccountId") or "") != account_id:
            continue
        if not media_order_is_retryable(order):
            return order
    return None


def assert_media_publish_target_available(
    db: Session,
    article_id: str,
    account_id: str,
    *,
    exclude_order_id: str = "",
) -> None:
    active_order = active_media_order_for_article_account(
        db,
        article_id,
        account_id,
        exclude_order_id=exclude_order_id,
    )
    if not active_order:
        return
    raise HTTPException(status_code=409, detail={
        "code": "ARTICLE_PUBLISH_ALREADY_ACTIVE",
        "message": "This article already has an active publish flow for this media account.",
        "articleId": article_id,
        "mediaAccountId": account_id,
        "mediaOrderId": active_order.get("id") or "",
        "publishStatus": active_order.get("status") or "",
    })


def publish_and_index(db: Session, payload: dict) -> dict:
    article_id = str(payload.get("articleId") or "")
    article = get_record(db, "articles", article_id)
    assert_article_editable(article, action="publish")
    site = get_record(db, "sites", str(payload.get("siteId") or ""))
    article = claim_article_publish(db, article_id)
    job = create_publish_job(db, article, site)
    task = create_task(db, "publish-and-index", f"�������£�{job['articleTitle']}", {
        "publishJobId": job["id"],
        "indexSubmissionId": "",
        "articleId": article["id"],
        "siteId": site["id"],
        "submitIndex": False,
    }, "publish")
    return {"publishJob": job, "indexSubmission": None, "task": task}


def create_media_order(db: Session, payload: dict) -> dict:
    resource = find_record(db, "mediaResources", str(payload.get("resourceId") or ""))
    resource_id_value = str(payload.get("resourceId") or "")
    account_id = str(payload.get("mediaAccountId") or payload.get("accountId") or "")
    if not account_id and resource_id_value.startswith("account:"):
        account_id = resource_id_value.removeprefix("account:")
    account = find_record(db, "mediaAccounts", account_id)
    resource_name = payload.get("resourceName") or resource and resource.get("name") or account and account.get("name") or "ý����Դ"
    resource_id = payload.get("resourceId") or (f"account:{account['id']}" if account else "resource-custom")
    platform = payload.get("platform") or account and account.get("platform") or ""
    order = {
        "id": payload.get("id") or make_id("mediaOrders"),
        "articleId": payload.get("articleId") or "",
        "articleTitle": payload.get("articleTitle") or payload.get("title") or "δ��������",
        "resourceId": resource_id,
        "resourceName": resource_name,
        "mediaAccountId": account_id,
        "platform": platform,
        "sourceCommandId": payload.get("sourceCommandId") or "",
        "attempt": max(1, int(payload.get("attempt") or 1)),
        "status": payload.get("status") or "pending",
        "backlinkStatus": payload.get("backlinkStatus") or "pending",
        "backlinkUrl": payload.get("backlinkUrl") or "",
        "reviewUrl": payload.get("reviewUrl") or payload.get("candidateUrl") or "",
        "platformStatus": payload.get("platformStatus") or "",
        "reviewStatus": payload.get("reviewStatus") or "",
        "publicVerifiedAt": payload.get("publicVerifiedAt") or "",
        "publicCheckCount": int(payload.get("publicCheckCount") or 0),
        "publicDiscoveryStatus": payload.get("publicDiscoveryStatus") or "",
        "publicDiscoveryCount": int(payload.get("publicDiscoveryCount") or 0),
        "lastPublicDiscoveryAt": payload.get("lastPublicDiscoveryAt") or "",
        "imagePublicationEvidence": payload.get("imagePublicationEvidence") if isinstance(payload.get("imagePublicationEvidence"), dict) else {},
        "errorMessage": payload.get("errorMessage") or "",
        "price": payload.get("price") or resource and resource.get("price") or 0,
        "createdAt": payload.get("createdAt") or now_stamp(),
        "updatedAt": payload.get("updatedAt") or now_stamp(),
    }
    return save_record(db, "mediaOrders", order)


def media_order_account_id(order: dict) -> str:
    account_id = str(order.get("mediaAccountId") or "")
    if account_id:
        return account_id
    resource_id = str(order.get("resourceId") or "")
    return resource_id.removeprefix("account:") if resource_id.startswith("account:") else ""


def media_account_has_active_credentials(db: Session, account: dict) -> bool:
    if account.get("status") != "active" or account.get("credentialStatus") != "active":
        return False
    artifact = find_record(db, "mediaAuthArtifacts", str(account.get("authArtifactId") or ""))
    evidence = artifact.get("authorizationEvidence") if artifact else None
    return bool(
        artifact
        and artifact.get("status") == "active"
        and isinstance(evidence, dict)
        and evidence.get("strongCookiePresent") is True
        and evidence.get("workspaceReady") is True
    )


def platform_publish_rules(payload: dict, article: dict) -> dict:
    writer_context = article.get("writerContext") if isinstance(article.get("writerContext"), dict) else {}
    context_rules = writer_context.get("publishRules") if isinstance(writer_context.get("publishRules"), dict) else {}
    request_rules = payload.get("platformRules") if isinstance(payload.get("platformRules"), dict) else {}
    allowed_keys = [
        "category",
        "articleType",
        "visibility",
        "creationStatement",
        "backupToGitCode",
        "coverImagePath",
        "coverMode",
        "apiFirst",
        "verifyPublication",
        "disposableTest",
        "preserveDraftOnManualVerification",
        "cleanupTestArticle",
    ]
    direct_rules = {key: payload[key] for key in allowed_keys if key in payload}
    rules = {**context_rules, **request_rules, **direct_rules}
    return {key: rules[key] for key in allowed_keys if key in rules}


def latest_active_publish_device_id(db: Session, bound_device_id: str) -> str:
    bound_device = find_record(db, "desktopDevices", bound_device_id)
    devices = [device for device in list_records(db, "desktopDevices") if device.get("status") == "active"]
    if not devices:
        return bound_device_id
    public_key = str(bound_device.get("publicKey") or "") if bound_device else ""
    if public_key:
        same_installation_devices = [device for device in devices if str(device.get("publicKey") or "") == public_key]
        if same_installation_devices:
            devices = same_installation_devices
    latest = max(devices, key=lambda device: (desktop_device_recency_timestamp(device), str(device.get("id") or "")))
    return str(latest.get("id") or bound_device_id)


def publish_inline_images(article: dict) -> list[dict]:
    """Inline images from the first location that still holds them.

    Once the writer clears the top-level fields, the only surviving copy lives
    under writerContext, and _source_content_blocks already falls back to it.
    Reading the top-level list alone produced image blocks with neither url nor
    path, which the desktop agent cannot turn into a local file.
    """
    writer_context = article.get("writerContext") if isinstance(article.get("writerContext"), dict) else {}
    for source in (article.get("inlineImages"), writer_context.get("inlineImages")):
        if isinstance(source, list) and source:
            return [image for image in source if isinstance(image, dict)]
    return []


def queue_article_media_publish_command(
    db: Session,
    article: dict,
    account_id: str,
    payload: dict | None = None,
    source: str = "article-publish",
) -> dict:
    options = payload if isinstance(payload, dict) else {}
    account = resolve_media_account(db, account_id)
    if not media_account_has_active_credentials(db, account):
        raise HTTPException(status_code=400, detail="MEDIA_ACCOUNT_NOT_AUTHORIZED")

    binding = next((
        item for item in reversed(list_records(db, "mediaAccountBindings"))
        if item.get("mediaAccountId") == account["id"] and item.get("status") == "active"
    ), None)
    if not binding or not binding.get("deviceId"):
        raise HTTPException(status_code=400, detail="MEDIA_ACCOUNT_DEVICE_BINDING_REQUIRED")
    bound_device_id = str(binding["deviceId"])
    requested_device_id = str(options.get("deviceId") or "")
    if requested_device_id and requested_device_id != bound_device_id:
        raise HTTPException(status_code=403, detail="DESKTOP_COMMAND_DEVICE_MISMATCH")
    command_device_id = requested_device_id or latest_active_publish_device_id(db, bound_device_id)
    if command_device_id != bound_device_id:
        binding = patch_record(db, "mediaAccountBindings", binding["id"], {"deviceId": command_device_id})

    artifact = find_record(
        db,
        "mediaAuthArtifacts",
        str(account.get("authArtifactId") or binding.get("artifactId") or ""),
    )
    session_id = str(binding.get("sessionId") or artifact and artifact.get("sessionId") or "")
    dedupe_key = str(options.get("dedupeKey") or "")
    if dedupe_key:
        existing = next((
            item for item in reversed(list_records(db, "desktopCommands"))
            if item.get("type") == "publish_article"
            and item.get("mediaAccountId") == account["id"]
            and item.get("status") in {"queued", "running", "succeeded"}
            and isinstance(item.get("payload"), dict)
            and item["payload"].get("dedupeKey") == dedupe_key
        ), None)
        if existing:
            existing_result = existing.get("result") if isinstance(existing.get("result"), dict) else {}
            existing_order = find_record(db, "mediaOrders", str(existing_result.get("mediaOrderId") or ""))
            return {"command": existing, "account": account, "mediaOrder": existing_order, "deduplicated": True}

    reusable_order_id = str(options.get("reuseMediaOrderId") or article.get("mediaOrderId") or "")
    reusable_order = find_record(db, "mediaOrders", reusable_order_id) if reusable_order_id else None
    if not reusable_order:
        reusable_order = next((
            order for order in reversed(list_records(db, "mediaOrders"))
            if str(order.get("articleId") or "") == str(article.get("id") or "")
            and str(order.get("mediaAccountId") or "") == account["id"]
            and str(order.get("status") or "") == "failed"
        ), None)
    if reusable_order and (
        str(reusable_order.get("status") or "") != "failed"
        or str(reusable_order.get("articleId") or "") != str(article.get("id") or "")
        or str(reusable_order.get("mediaAccountId") or "") != account["id"]
    ):
        reusable_order = None

    assert_media_publish_target_available(
        db,
        str(article.get("id") or ""),
        account["id"],
        exclude_order_id=str(reusable_order.get("id") or "") if reusable_order else "",
    )
    prior_attempts = [
        int(order.get("attempt") or 1)
        for order in list_records(db, "mediaOrders")
        if str(order.get("articleId") or "") == str(article.get("id") or "")
        and str(order.get("mediaAccountId") or "") == account["id"]
    ]
    attempt_number = (
        max(1, int(options.get("attempt") or 1))
        if options.get("attempt") is not None
        else max(prior_attempts, default=0) + 1
    )
    confirm_publish = options.get("confirmPublish") is True or options.get("publishMode") == "publish"
    rules = platform_publish_rules(options, article)
    platform = str(account.get("platform") or "other")
    operation_timeout_ms = options.get("operationTimeoutMs")
    if operation_timeout_ms is None and platform == "sohu":
        operation_timeout_ms = 600000
    cover_image = article.get("coverImage") if isinstance(article.get("coverImage"), dict) else {}
    section_order = {
        str(section.get("id") or ""): index
        for index, section in enumerate(article.get("sections") or [])
        if isinstance(section, dict)
    }
    inline_images = sorted(
        publish_inline_images(article),
        key=lambda image: section_order.get(str(image.get("sectionId") or ""), len(section_order)),
    )
    publish_images = [{
        "assetId": image.get("assetId") or "",
        "purpose": image.get("purpose") or "inline",
        "sectionId": image.get("sectionId") or "",
        "url": image.get("url") or "",
        "path": image.get("path") or "",
        "altText": image.get("altText") or "文章配图",
    } for image in inline_images]
    content_blocks = build_content_blocks(article, publish_images)
    content_html = compose_rich_article_html(content_blocks, include_images=True)
    content_html_without_images = compose_rich_article_html(content_blocks, include_images=False)
    command_id = make_id("desktopCommands")
    media_order_id = reusable_order["id"] if reusable_order else f"media-order-{command_id.removeprefix('desktop-command-')}"
    command = save_record(db, "desktopCommands", {
        "id": command_id,
        "deviceId": command_device_id,
        "type": "publish_article",
        "mediaAccountId": account["id"],
        "payload": {
            "articleId": article["id"],
            "autoPublishTaskId": options.get("autoPublishTaskId") or "",
            "dedupeKey": dedupe_key,
            "attempt": attempt_number,
            "retryOfCommandId": options.get("retryOfCommandId") or (reusable_order.get("sourceCommandId") if reusable_order else "") or "",
            "platform": platform,
            "sessionId": session_id,
            "accountName": account.get("accountName") or account.get("name") or "",
            "authArtifactId": account.get("authArtifactId") or "",
            "articleTitle": article.get("title") or "未命名文章",
            "title": article.get("title") or "未命名文章",
            "summary": article.get("summary") or "",
            "contentMarkdown": article.get("contentMarkdown") or "",
            "keywords": article.get("keywords") or [],
            "tags": article.get("tags") or article.get("keywords") or [],
            "coverImagePath": cover_image.get("path") or "",
            "coverImageUrl": cover_image.get("url") or "",
            "coverImageAltText": cover_image.get("altText") or "",
            "inlineImages": publish_images,
            "contentBlocks": content_blocks,
            "contentHtml": content_html,
            "contentHtmlWithoutImages": content_html_without_images,
            "confirmPublish": confirm_publish,
            "publishMode": "publish" if confirm_publish else "draft",
            "submitIndex": False,
            "provider": options.get("provider") or "",
            "checkImmediately": bool(options.get("checkImmediately")),
            "headless": options.get("headless", True) is not False,
            "keepBrowserOpen": bool(options.get("keepBrowserOpen", False)),
            "allowForeground": bool(options.get("allowForeground", False)),
            "operationTimeoutMs": operation_timeout_ms,
            **rules,
        },
        "status": "queued",
        "result": {"mediaOrderId": media_order_id},
        "errorMessage": "",
        "createdAt": now_stamp(),
        "updatedAt": now_stamp(),
    })
    media_order_payload = {
        "articleId": article["id"],
        "articleTitle": article.get("title") or "未命名文章",
        "resourceId": f"account:{account['id']}",
        "resourceName": account.get("name") or account.get("accountName") or "免费媒体账号",
        "mediaAccountId": account["id"],
        "platform": platform,
        "sourceCommandId": command["id"],
        "attempt": attempt_number,
        "status": "pending",
        "backlinkStatus": "pending",
        "backlinkUrl": "",
        "reviewUrl": "",
        "platformStatus": "queued",
        "reviewStatus": "",
        "publicVerifiedAt": "",
        "publicCheckCount": 0,
        "publicDiscoveryStatus": "",
        "publicDiscoveryCount": 0,
        "lastPublicDiscoveryAt": "",
        "imagePublicationEvidence": {},
        "errorMessage": "",
    }
    media_order = (
        patch_record(db, "mediaOrders", reusable_order["id"], media_order_payload)
        if reusable_order
        else create_media_order(db, {"id": media_order_id, **media_order_payload})
    )
    patch_record(db, "articles", article["id"], {
        "publishStatus": "pending",
        "publicationStatus": "pending",
        "mediaPublishStatus": "pending",
        "mediaOrderId": media_order["id"],
        "mediaAccountId": account["id"],
        "mediaPlatform": platform,
    })
    audit_event(db, "desktop_command.create", "desktopCommands", command["id"], {
        "type": "publish_article",
        "deviceId": command.get("deviceId"),
        "source": source,
        "autoPublishTaskId": options.get("autoPublishTaskId") or "",
        "mediaOrderId": media_order["id"],
    })
    return {"command": command, "account": account, "mediaOrder": media_order, "deduplicated": False}


def current_auto_publish_commands(db: Session, auto_publish_task_id: str) -> list[dict]:
    commands = [
        command for command in list_records(db, "desktopCommands")
        if command.get("type") == "publish_article"
        and isinstance(command.get("payload"), dict)
        and command["payload"].get("autoPublishTaskId") == auto_publish_task_id
    ]
    current_by_target: dict[str, tuple[tuple[int, int], dict]] = {}
    for position, command in enumerate(commands):
        payload = command["payload"]
        logical_key = str(payload.get("dedupeKey") or "")
        if not logical_key:
            article_id = str(payload.get("articleId") or "")
            account_id = str(command.get("mediaAccountId") or "")
            logical_key = f"{article_id}:{account_id}" if article_id and account_id else command["id"]
        rank = (max(1, int(payload.get("attempt") or 1)), position)
        current = current_by_target.get(logical_key)
        if current is None or rank > current[0]:
            current_by_target[logical_key] = (rank, command)
    return [item[1] for item in current_by_target.values()]


def sync_auto_publish_task_status(db: Session, auto_publish_task_id: str) -> dict | None:
    batch = find_record(db, "autoPublishTasks", auto_publish_task_id)
    if not batch:
        return None
    commands = current_auto_publish_commands(db, auto_publish_task_id)
    if not commands:
        return batch

    def command_requires_manual_action(command: dict) -> bool:
        result = command.get("result") if isinstance(command.get("result"), dict) else {}
        error_text = f"{command.get('errorMessage') or ''} {result.get('platformStatus') or ''} {result.get('message') or ''}"
        return (
            result.get("platformStatus") == "manual_verification_required"
            or "MANUAL_ACTION_REQUIRED" in error_text.upper()
            or "MANUAL_VERIFICATION_REQUIRED" in error_text.upper()
        )

    succeeded = sum(command.get("status") == "succeeded" for command in commands)
    failed = sum(command.get("status") == "failed" for command in commands)
    manual_action = sum(command_requires_manual_action(command) for command in commands)
    pending = len(commands) - succeeded - failed
    manual_message = next((
        str((command.get("result") if isinstance(command.get("result"), dict) else {}).get("message") or command.get("errorMessage") or "ƽ̨������ȫ��֤���������������������֤�����ԡ�")
        for command in commands
        if command_requires_manual_action(command)
    ), "")
    status = "manual_action_required" if manual_action else "publishing" if pending else "partial_failed" if failed and succeeded else "failed" if failed else "succeeded"
    return patch_record(db, "autoPublishTasks", auto_publish_task_id, {
        "status": status,
        "desktopCommandIds": [command["id"] for command in commands],
        "queuedPublishCount": len(commands),
        "publishPendingCount": pending,
        "publishSucceededCount": succeeded,
        "publishFailedCount": failed,
        "publishManualActionCount": manual_action,
        "lastError": manual_message or batch.get("lastError") or "",
        "updatedAt": now_stamp(),
    })


def retry_auto_publish_failures(db: Session, auto_publish_task_id: str) -> dict:
    get_record(db, "autoPublishTasks", auto_publish_task_id)
    failed_commands = [
        command for command in current_auto_publish_commands(db, auto_publish_task_id)
        if command.get("status") == "failed"
    ]
    if not failed_commands:
        raise HTTPException(status_code=400, detail="AUTO_PUBLISH_NO_FAILED_COMMANDS")

    retried_commands = []
    for failed_command in failed_commands:
        payload = failed_command.get("payload") if isinstance(failed_command.get("payload"), dict) else {}
        article_id = str(payload.get("articleId") or "")
        account_id = str(failed_command.get("mediaAccountId") or "")
        article = get_record(db, "articles", article_id)
        dedupe_key = str(payload.get("dedupeKey") or f"{auto_publish_task_id}:{article_id}:{account_id}")
        queued = queue_article_media_publish_command(
            db,
            article,
            account_id,
            {
                **payload,
                "autoPublishTaskId": auto_publish_task_id,
                "dedupeKey": dedupe_key,
                "attempt": max(1, int(payload.get("attempt") or 1)) + 1,
                "retryOfCommandId": failed_command["id"],
            },
            source="auto-publish-retry",
        )
        retried_commands.append(queued["command"])

    batch = sync_auto_publish_task_status(db, auto_publish_task_id)
    audit_event(db, "auto_publish.retry_failed_commands", "autoPublishTasks", auto_publish_task_id, {
        "failedCommandIds": [command["id"] for command in failed_commands],
        "retryCommandIds": [command["id"] for command in retried_commands],
    })
    return {"autoPublishTask": batch, "desktopCommands": retried_commands}


def queue_media_publication_discovery(db: Session, payload: dict) -> dict:
    order = get_record(db, "mediaOrders", str(payload.get("orderId") or payload.get("id") or ""))
    account_id = media_order_account_id(order)
    if not account_id:
        raise HTTPException(status_code=400, detail="PUBLICATION_DISCOVERY_ACCOUNT_REQUIRED")
    account = resolve_media_account(db, account_id)
    account_id = account["id"]
    platform = str(order.get("platform") or account.get("platform") or "")
    if platform not in PUBLICATION_DISCOVERY_PLATFORMS:
        raise HTTPException(status_code=400, detail="PUBLICATION_DISCOVERY_NOT_SUPPORTED")
    if not media_account_has_active_credentials(db, account):
        raise HTTPException(status_code=400, detail="MEDIA_ACCOUNT_NOT_AUTHORIZED")

    binding = next((
        item for item in reversed(list_records(db, "mediaAccountBindings"))
        if item.get("mediaAccountId") == account_id and item.get("status") == "active"
    ), None)
    if not binding:
        raise HTTPException(status_code=400, detail="MEDIA_ACCOUNT_BINDING_REQUIRED")
    bound_device_id = str(binding.get("deviceId") or "").strip()
    requested_device_id = str(payload.get("deviceId") or "").strip()
    if requested_device_id and requested_device_id != bound_device_id:
        raise HTTPException(status_code=403, detail="DESKTOP_COMMAND_DEVICE_MISMATCH")
    target_device_id = requested_device_id or latest_active_publish_device_id(db, bound_device_id)
    if target_device_id and target_device_id != bound_device_id:
        binding = patch_record(db, "mediaAccountBindings", binding["id"], {"deviceId": target_device_id})

    if payload.get("forceDiscovery") is not True:
        for command in reversed(list_records(db, "desktopCommands")):
            command_payload = command.get("payload") if isinstance(command.get("payload"), dict) else {}
            if (
                command.get("type") == "discover_publication"
                and command.get("status") in {"queued", "running"}
                and str(command_payload.get("mediaOrderId") or "") == order["id"]
            ):
                command_device_id = str(command.get("deviceId") or "").strip()
                if target_device_id and command_device_id and command_device_id != target_device_id:
                    patch_record(db, "desktopCommands", command["id"], {
                        "status": "failed",
                        "errorMessage": "DESKTOP_COMMAND_STALE_DEVICE",
                    })
                    continue
                if stale_running_desktop_discovery_command(command):
                    patch_record(db, "desktopCommands", command["id"], {
                        "status": "failed",
                        "errorMessage": "DESKTOP_COMMAND_STALE_TIMEOUT",
                    })
                    continue
                reconciled_order = patch_record(db, "mediaOrders", order["id"], {
                    "publicDiscoveryStatus": "queued",
                    "errorMessage": "",
                    "updatedAt": now_stamp(),
                })
                return {"queued": True, "task": None, "desktopCommand": command, "mediaOrder": reconciled_order, "deduplicated": True}

    artifact = find_record(db, "mediaAuthArtifacts", str(account.get("authArtifactId") or binding.get("artifactId") or ""))
    session_id = str(binding.get("sessionId") or artifact and artifact.get("sessionId") or "")
    article_id = str(order.get("articleId") or "")
    article = find_record(db, "articles", article_id) if article_id else None
    image_publication_evidence = order.get("imagePublicationEvidence") if isinstance(order.get("imagePublicationEvidence"), dict) else {}
    if not image_publication_evidence:
        image_publication_evidence = article_image_publication_evidence_seed(article)
        if image_publication_evidence:
            order = patch_record(db, "mediaOrders", order["id"], {
                "imagePublicationEvidence": image_publication_evidence,
                "updatedAt": now_stamp(),
            })
    owner_id = str(order.get("ownerId") or account.get("ownerId") or binding.get("ownerId") or "").strip()
    command_id = make_id("desktopCommands")
    media_order_id = order["id"]
    command = save_record(db, "desktopCommands", {
        "id": command_id,
        **({"ownerId": owner_id} if owner_id else {}),
        "deviceId": target_device_id,
        "type": "discover_publication",
        "mediaAccountId": account_id,
        "payload": {
            "mediaOrderId": order["id"],
            "articleId": article_id,
            "articleTitle": order.get("articleTitle") or "",
            "contentMarkdown": article.get("contentMarkdown") if article else "",
            "platform": platform,
            "publicUrl": payload.get("url") or payload.get("publicUrl") or payload.get("reviewUrl") or order.get("reviewUrl") or order.get("backlinkUrl") or "",
            "reviewUrl": payload.get("reviewUrl") or order.get("reviewUrl") or order.get("backlinkUrl") or "",
            "imagePublicationEvidence": image_publication_evidence,
            "sessionId": session_id,
            "authArtifactId": account.get("authArtifactId") or binding.get("artifactId") or "",
            "provider": payload.get("provider") or "IndexNow",
            "checkImmediately": bool(payload.get("checkImmediately", True)),
            "headless": payload.get("headless", True) is not False,
            "keepBrowserOpen": bool(payload.get("keepBrowserOpen", False)),
            "allowForeground": bool(payload.get("allowForeground", False)),
        },
        "status": "queued",
        "result": {"mediaOrderId": media_order_id},
        "errorMessage": "",
        "createdAt": now_stamp(),
        "updatedAt": now_stamp(),
    })
    updated_order = patch_record(db, "mediaOrders", order["id"], {
        "mediaAccountId": account_id,
        "platform": platform,
        "sourceCommandId": payload.get("sourceCommandId") or "",
        "attempt": max(1, int(payload.get("attempt") or 1)),
        "errorMessage": "",
        "publicDiscoveryStatus": "queued",
        "publicDiscoveryCount": int(order.get("publicDiscoveryCount") or 0) + 1,
        "lastPublicDiscoveryAt": now_stamp(),
        "updatedAt": now_stamp(),
    })
    audit_event(db, "media.publication_discovery_queued", "mediaOrders", order["id"], {
        "desktopCommandId": command["id"],
        "mediaAccountId": account_id,
    })
    return {"queued": True, "task": None, "desktopCommand": command, "mediaOrder": updated_order, "deduplicated": False}


def fetch_public_page_text(url: str) -> str:
    import httpx

    response = httpx.get(
        url,
        follow_redirects=True,
        timeout=20,
        headers={"User-Agent": "ZhixinAI-PublicationVerifier/1.0"},
    )
    response.raise_for_status()
    return response.text


def normalize_publication_text(value: str) -> str:
    return re.sub(r"\s+", "", str(value or "")).lower()
def is_public_http_url(value: str) -> bool:
    try:
        parsed = urlsplit(str(value or "").strip())
    except ValueError:
        return False
    return parsed.scheme.lower() in {"http", "https"} and bool(parsed.hostname)


def article_publication_matches(article: dict, order: dict, page_text: str) -> bool:
    haystack = normalize_publication_text(page_text)
    if not haystack:
        return False
    title = normalize_publication_text(article.get("title") or order.get("articleTitle") or "")
    if title and title in haystack:
        return True
    content = str(article.get("contentMarkdown") or "")
    content = re.sub(r"[#>*_`\-\[\]()!]", "", content)
    snippets = [
        normalize_publication_text(paragraph)[:32]
        for paragraph in re.split(r"\n{2,}", content)
        if len(normalize_publication_text(paragraph)) >= 16
    ]
    return any(snippet and snippet in haystack for snippet in snippets)


def _evidence_int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _image_identity(item: dict) -> tuple[str, str, int]:
    return (
        str(item.get("assetId") or ""),
        str(item.get("sectionId") or ""),
        _evidence_int(item.get("position")),
    )


def _image_stage(evidence: dict, name: str) -> dict:
    stage = evidence.get(name)
    return stage if isinstance(stage, dict) else {}


def _article_publish_image_identities(article: dict | None) -> list[tuple[str, str]]:
    if not isinstance(article, dict):
        return []
    identities: list[tuple[str, str]] = []

    def add_image(item: Any) -> None:
        if not isinstance(item, dict):
            return
        image_key = str(item.get("assetId") or item.get("url") or item.get("path") or "").strip()
        if not image_key:
            return
        identity = (image_key, str(item.get("sectionId") or "").strip())
        if identity not in identities:
            identities.append(identity)

    for block in article.get("contentBlocks") or []:
        if isinstance(block, dict) and block.get("type") == "image":
            add_image(block)
    for image in article.get("inlineImages") or []:
        add_image(image)
    if not identities and re.search(r"!\[[^\]]*\]\([^)]+\)", str(article.get("contentMarkdown") or "")):
        identities.append(("markdown-image", ""))
    return identities


def article_publish_image_count(article: dict | None) -> int:
    return len(_article_publish_image_identities(article))


def article_image_publication_evidence_seed(article: dict | None) -> dict:
    if not isinstance(article, dict):
        return {}
    expected: list[dict] = []
    seen: set[tuple[str, str]] = set()

    def add_image(item: Any, position: int) -> None:
        if not isinstance(item, dict):
            return
        asset_id = str(item.get("assetId") or item.get("url") or item.get("path") or "").strip()
        if not asset_id:
            return
        section_id = str(item.get("sectionId") or "").strip()
        identity = (asset_id, section_id)
        if identity in seen:
            return
        seen.add(identity)
        expected.append({
            "assetId": asset_id,
            "sectionId": section_id,
            "position": _evidence_int(item.get("position")) or position,
            "idempotencyKey": str(item.get("idempotencyKey") or f"{asset_id}:{section_id}:{position}"),
        })

    for index, block in enumerate(article.get("contentBlocks") or []):
        if isinstance(block, dict) and block.get("type") == "image":
            add_image(block, index)
    for index, image in enumerate(article.get("inlineImages") or [], start=len(expected) + 1):
        add_image(image, index)
    if not expected and re.search(r"!\[[^\]]*\]\([^)]+\)", str(article.get("contentMarkdown") or "")):
        expected.append({
            "assetId": "markdown-image",
            "sectionId": "",
            "position": 1,
            "idempotencyKey": "markdown-image:1",
        })
    if not expected:
        return {}
    pending_stage = {"status": "pending", "expectedCount": len(expected), "observedCount": 0, "verifiedCount": 0, "images": []}
    return {
        "version": 1,
        "status": "review_required",
        "expectedCount": len(expected),
        "expected": expected,
        "upload": dict(pending_stage),
        "draft": dict(pending_stage),
        "public": dict(pending_stage),
        "issues": ["PUBLIC_IMAGE_PENDING"],
    }


def media_order_requires_image_publication_evidence(order: dict, article: dict | None = None) -> bool:
    evidence = order.get("imagePublicationEvidence")
    if article_publish_image_count(article) > 0:
        return True
    if not isinstance(evidence, dict) or not evidence:
        return False
    if _evidence_int(evidence.get("expectedCount")) > 0:
        return True
    if any(isinstance(item, dict) for item in evidence.get("expected") or []):
        return True
    if str(evidence.get("status") or "").strip() and evidence.get("status") != "verified":
        return True
    if any(str(issue or "").strip() for issue in evidence.get("issues") or []):
        return True
    for stage_name in ["upload", "draft", "public"]:
        stage = _image_stage(evidence, stage_name)
        if _evidence_int(stage.get("expectedCount")) > 0 or stage.get("images"):
            return True
    return False


PUBLIC_ONLY_IMAGE_EVIDENCE_STAGES = ("upload", "draft")
PUBLIC_ONLY_IMAGE_EVIDENCE_ISSUES = {"UPLOAD_IMAGE_MISSING", "DRAFT_IMAGE_MISSING"}
# A public page the platform refused to show us (captcha, login wall, risk control) was
# never observed, so it is a signal gap rather than a missing image. It has to stay
# visible in the evidence, but it must not be able to gate an order forever.
UNVERIFIABLE_IMAGE_EVIDENCE_STATUS = "unverifiable"
UNVERIFIABLE_IMAGE_EVIDENCE_ISSUES = {"PUBLIC_IMAGE_UNVERIFIABLE"}


def blocking_image_evidence_issues(evidence: Any) -> list[str]:
    """Issues that really describe a defect, with the unobservable ones filtered out."""
    return [
        str(issue or "")
        for issue in (evidence.get("issues") if isinstance(evidence, dict) else []) or []
        if str(issue or "").strip() and str(issue or "") not in UNVERIFIABLE_IMAGE_EVIDENCE_ISSUES
    ]


def _image_stage_has_observations(stage: dict) -> bool:
    if not isinstance(stage, dict):
        return False
    if _evidence_int(stage.get("observedCount")) > 0 or _evidence_int(stage.get("verifiedCount")) > 0:
        return True
    return any(isinstance(image, dict) for image in stage.get("images") or [])


def image_publication_evidence_public_blocker(evidence: Any) -> str:
    """Why the public image stage could not be observed, when it could not be observed.

    A public page the platform refused to show us (login wall, captcha, risk control) is a
    different situation from a page we read and found images missing from. Both leave the
    order gated, but only the second one is a defect, so the operator needs to be able to
    tell them apart from the order error message.
    """
    stage = _image_stage(evidence if isinstance(evidence, dict) else {}, "public")
    if str(stage.get("status") or "") != "unverifiable":
        return ""
    return str(stage.get("unverifiableReason") or stage.get("blocker") or "").strip()


def image_publication_evidence_recovery_stages(order: dict) -> list[str]:
    """Upload/draft stages this order never observed, so no recheck can ever re-observe them.

    A publish attempt that aborts after the platform accepted the article leaves those two
    stages empty for good: the platform draft is deleted on publish, so only the public page
    can still produce evidence. Stages that did record observations stay gated.
    """
    evidence = order.get("imagePublicationEvidence") if isinstance(order, dict) else None
    if not isinstance(evidence, dict) or not evidence:
        return list(PUBLIC_ONLY_IMAGE_EVIDENCE_STAGES)
    unobserved = []
    for stage_name in PUBLIC_ONLY_IMAGE_EVIDENCE_STAGES:
        stage = _image_stage(evidence, stage_name)
        stage_status = str(stage.get("status") or "")
        # Treating an unverifiable upload/draft stage as unobserved lets the recovery
        # path rewrite it. Leaving it as "unverifiable" would instead freeze the order:
        # the not_observed exemption below is the only one those stages can use.
        if (
            stage_status in {"not_observed", UNVERIFIABLE_IMAGE_EVIDENCE_STATUS}
            or not _image_stage_has_observations(stage)
        ):
            unobserved.append(stage_name)
    return unobserved


def recover_public_only_image_publication_evidence(order: dict, evidence: dict | None) -> dict | None:
    """Let a fully verified public page stand in for upload/draft stages that were never observed.

    The public stage keeps its own full check (verified count and image identity match), so a
    genuinely broken image upload still fails: an empty public page never reaches "verified".
    """
    if not isinstance(evidence, dict) or not evidence:
        return evidence
    recovery_stages = image_publication_evidence_recovery_stages(order)
    if not recovery_stages:
        return evidence
    recovered = dict(evidence)
    for stage_name in recovery_stages:
        stage = _image_stage(recovered, stage_name)
        if str(stage.get("status") or "") == "not_observed":
            continue
        recovered[stage_name] = {
            **stage,
            "status": "not_observed",
            "observedCount": 0,
            "verifiedCount": 0,
            "images": [],
        }
    if "issues" in recovered:
        recovered["issues"] = [
            str(issue or "")
            for issue in recovered.get("issues") or []
            if str(issue or "") not in PUBLIC_ONLY_IMAGE_EVIDENCE_ISSUES
        ]
    remaining_issues = [issue for issue in recovered.get("issues") or [] if issue]
    public_stage = _image_stage(recovered, "public")
    if public_stage.get("status") == "verified" and not remaining_issues:
        recovered["status"] = "verified"
        if not str(recovered.get("verifiedAt") or ""):
            recovered["verifiedAt"] = now_stamp()
    elif str(recovered.get("status") or "") not in {"review_required", "failed"}:
        recovered["status"] = "review_required"
    return recovered


def media_order_image_publication_evidence_is_verified(order: dict, article: dict | None = None) -> bool:
    evidence = order.get("imagePublicationEvidence")
    article_image_count = article_publish_image_count(article)
    if not isinstance(evidence, dict) or not evidence:
        return article_image_count == 0
    # "review_required" only reaches here with no blocking issue left, which means the
    # sole cause was an unobservable public page: still not a pass on the images, but
    # not a defect either, so the upload/draft evidence is allowed to carry the order.
    if str(evidence.get("status") or "") not in {"verified", "review_required"}:
        return False
    if blocking_image_evidence_issues(evidence):
        return False
    expected = [item for item in evidence.get("expected") or [] if isinstance(item, dict)]
    expected_identities = [_image_identity(item) for item in expected]
    expected_count = max(
        _evidence_int(evidence.get("expectedCount")),
        len(expected_identities),
        *[_evidence_int(_image_stage(evidence, stage).get("expectedCount")) for stage in ["upload", "draft", "public"]],
    )
    if article_image_count > 0 and expected_count < article_image_count:
        return False
    if expected_count <= 0:
        return article_image_count == 0
    if expected_identities and len(expected_identities) != expected_count:
        return False
    for stage_name in ["upload", "draft", "public"]:
        stage = _image_stage(evidence, stage_name)
        if stage_name in PUBLIC_ONLY_IMAGE_EVIDENCE_STAGES and str(stage.get("status") or "") == "not_observed":
            continue
        if stage_name == "public" and str(stage.get("status") or "") == UNVERIFIABLE_IMAGE_EVIDENCE_STATUS:
            continue
        if stage.get("status") != "verified" or _evidence_int(stage.get("verifiedCount")) < expected_count:
            return False
        if expected_identities:
            images = [item for item in stage.get("images") or [] if isinstance(item, dict)]
            if [_image_identity(item) for item in images] != expected_identities:
                return False
    return True


def find_index_submission_for_url(db: Session, url: str, source_id: str = "") -> dict | None:
    for submission in list_records(db, "indexSubmissions"):
        if submission.get("url") == url:
            if not source_id or submission.get("sourceId") == source_id:
                return submission
    return None


def verify_media_order_publication(
    db: Session,
    payload: dict,
    url_fetcher: Callable[[str], str] | None = None,
) -> dict:
    order = get_record(db, "mediaOrders", str(payload.get("orderId") or payload.get("id") or ""))
    article = find_record(db, "articles", str(order.get("articleId") or "")) or {}
    account_id = media_order_account_id(order)
    account = find_record(db, "mediaAccounts", account_id) if account_id else None
    platform = str(order.get("platform") or account and account.get("platform") or "")
    uses_publication_discovery = platform in REVIEW_PUBLICATION_DISCOVERY_PLATFORMS
    candidate_url = str(
        payload.get("url")
        or payload.get("publicUrl")
        or payload.get("reviewUrl")
        or order.get("reviewUrl")
        or order.get("backlinkUrl")
        or ""
    ).strip()
    check_count = int(order.get("publicCheckCount") or 0) + 1
    # publicCheckAt is the stamp the scheduler's recheck backoff measures against.
    # updatedAt alone would not do: other patches touch it too, so the backoff
    # would silently reset and recheck on every tick.
    base_patch = {
        "publicCheckCount": check_count,
        "publicCheckAt": now_stamp(),
        "updatedAt": now_stamp(),
    }
    discovery_pending_patch = {"publicDiscoveryStatus": "pending"} if uses_publication_discovery else {}
    discovery_candidate_patch = {"publicDiscoveryStatus": "candidate_found"} if uses_publication_discovery else {}
    if not candidate_url:
        updated = patch_record(db, "mediaOrders", order["id"], {
            **base_patch,
            **discovery_pending_patch,
            "status": "review_required",
            "backlinkStatus": "blocked",
            "reviewStatus": order.get("reviewStatus") or "pending_public_visibility",
            "errorMessage": "缺少可复验的公开候选 URL，等待平台审核后再次复验。",
        })
        return {"verified": False, "reason": "PUBLIC_URL_MISSING", "mediaOrder": updated, "indexSubmission": None}
    if not candidate_url.startswith(("http://", "https://")):
        updated = patch_record(db, "mediaOrders", order["id"], {
            **base_patch,
            **discovery_pending_patch,
            "reviewUrl": candidate_url,
            "status": "review_required",
            "backlinkStatus": "blocked",
            "reviewStatus": "pending_public_visibility",
            "errorMessage": "公开候选 URL 格式无效，等待平台生成有效公开链接。",
        })
        return {"verified": False, "reason": "PUBLIC_URL_INVALID", "mediaOrder": updated, "indexSubmission": None}
    page_text = str(payload.get("pageText") or "") if payload.get("trustedDesktopEvidence") is True else ""
    if page_text and not candidate_publication_url_is_publishable(platform, candidate_url, page_text):
        updated = patch_record(db, "mediaOrders", order["id"], {
            **base_patch,
            **discovery_pending_patch,
            "reviewUrl": candidate_url,
            "status": "review_required",
            "backlinkStatus": "reviewing",
            "reviewStatus": "pending_public_visibility",
            "errorMessage": "候选 URL 不是平台真实公开文章页，暂不回写公开链接。",
        })
        return {"verified": False, "reason": "PUBLIC_URL_NOT_PUBLISHABLE", "mediaOrder": updated, "indexSubmission": None}
    try:
        if not page_text:
            page_text = (url_fetcher or fetch_public_page_text)(candidate_url)
    except Exception as exc:
        updated = patch_record(db, "mediaOrders", order["id"], {
            **base_patch,
            **discovery_candidate_patch,
            "reviewUrl": candidate_url,
            "status": "review_required",
            "backlinkStatus": "reviewing",
            "reviewStatus": "pending_public_visibility",
            "errorMessage": f"公开页暂时不可访问，等待平台审核或公开延迟后复验：{exc}",
        })
        return {"verified": False, "reason": "PUBLIC_PAGE_UNAVAILABLE", "mediaOrder": updated, "indexSubmission": None}

    if not candidate_publication_url_is_publishable(platform, candidate_url, page_text):
        updated = patch_record(db, "mediaOrders", order["id"], {
            **base_patch,
            **discovery_pending_patch,
            "reviewUrl": candidate_url,
            "status": "review_required",
            "backlinkStatus": "reviewing",
            "reviewStatus": "pending_public_visibility",
            "errorMessage": "公开页已访问，但不是平台真实可公开文章页，暂不回写公开链接。",
        })
        return {"verified": False, "reason": "PUBLIC_URL_NOT_PUBLISHABLE", "mediaOrder": updated, "indexSubmission": None}

    if not article_publication_matches(article, order, page_text):
        updated = patch_record(db, "mediaOrders", order["id"], {
            **base_patch,
            **discovery_pending_patch,
            "reviewUrl": candidate_url,
            "status": "review_required",
            "backlinkStatus": "reviewing",
            "reviewStatus": "pending_public_visibility",
            "errorMessage": "公开页已访问，但标题或正文未匹配到本次文章，暂不回写公开链接。",
        })
        if article:
            patch_record(db, "articles", article["id"], {"publishStatus": "submitted_for_review", "indexStatus": "not_submitted", "updatedAt": now_stamp()})
        return {"verified": False, "reason": "PUBLIC_PAGE_NOT_MATCHED", "mediaOrder": updated, "indexSubmission": None}

    if (
        media_order_requires_image_publication_evidence(order, article)
        and not media_order_image_publication_evidence_is_verified(order, article)
    ):
        public_blocker = image_publication_evidence_public_blocker(order.get("imagePublicationEvidence"))
        incomplete_message = (
            "Public page matched, but the platform blocked the public page from being read; "
            "wait for the next recheck before backlink."
            if public_blocker
            else "Public page matched, but platform image evidence is incomplete; wait for desktop image verification before backlink."
        )
        updated = patch_record(db, "mediaOrders", order["id"], {
            **base_patch,
            **discovery_candidate_patch,
            "reviewUrl": candidate_url,
            "backlinkUrl": "",
            "status": "review_required",
            "backlinkStatus": "reviewing",
            "reviewStatus": "pending_public_visibility",
            "errorMessage": incomplete_message,
        })
        if article:
            patch_record(db, "articles", article["id"], {
                "publishedUrl": "",
                "publishStatus": order.get("platformStatus") or "submitted_for_review",
                "publicationStatus": "review_required",
                "mediaPublishStatus": "review_required",
                "mediaBacklinkStatus": "reviewing",
                "mediaOrderId": updated["id"],
                "mediaAccountId": updated.get("mediaAccountId") or account_id or "",
                "mediaPlatform": platform,
                "mediaReviewUrl": candidate_url,
                "mediaPublishedUrl": "",
                "mediaPublicDiscoveryStatus": updated.get("publicDiscoveryStatus") or "",
                "indexStatus": "not_submitted",
                "updatedAt": now_stamp(),
            })
        return {"verified": False, "reason": "PUBLIC_IMAGE_EVIDENCE_INCOMPLETE", "mediaOrder": updated, "indexSubmission": None}

    updated = patch_record(db, "mediaOrders", order["id"], {
        **base_patch,
        **({"publicDiscoveryStatus": "found"} if uses_publication_discovery else {}),
        "status": "succeeded",
        "backlinkStatus": "generated",
        "backlinkUrl": candidate_url,
        "reviewUrl": candidate_url,
        "platformStatus": "published",
        "reviewStatus": "public",
        "publicVerifiedAt": now_stamp(),
        "errorMessage": "",
    })
    submission = None
    if payload.get("submitIndex") is True:
        existing_submission = find_index_submission_for_url(db, candidate_url, order["id"])
        submission = existing_submission or create_index_submission(db, {
            "articleId": updated.get("articleId") or "",
            "articleTitle": updated["articleTitle"],
            "provider": payload.get("provider") or "IndexNow",
            "source": "media-publication-recheck",
            "sourceType": "media",
            "sourceId": updated["id"],
            "url": candidate_url,
        })
    if article:
        patch_record(db, "articles", article["id"], {
            "status": "published",
            "publishedUrl": candidate_url,
            "publishStatus": "published",
            "publicationStatus": "succeeded",
            "mediaPublishStatus": "succeeded",
            "mediaBacklinkStatus": "generated",
            "mediaOrderId": updated["id"],
            "mediaAccountId": updated.get("mediaAccountId") or account_id or "",
            "mediaPlatform": platform,
            "mediaReviewUrl": candidate_url,
            "mediaPublishedUrl": candidate_url,
            "mediaPublicDiscoveryStatus": updated.get("publicDiscoveryStatus") or "",
            "indexStatus": "not_submitted",
            "updatedAt": now_stamp(),
        })
    audit_event(db, "media.publication_verified", "mediaOrders", updated["id"], {"backlinkUrl": candidate_url, "indexSubmissionId": submission["id"] if submission else ""})
    return {"verified": True, "reason": "PUBLIC_PAGE_MATCHED", "mediaOrder": updated, "indexSubmission": submission}


def publish_media_backlink(db: Session, payload: dict, create_task_record: bool = True) -> dict:
    order = get_record(db, "mediaOrders", str(payload.get("orderId") or ""))
    backlink_url = str(order.get("backlinkUrl") or "").strip()
    provider_status = str(order.get("platformStatus") or "")
    provider_review_status = str(order.get("reviewStatus") or "")
    provider_error = ""

    if not backlink_url:
        resource = find_record(db, "mediaResources", str(order.get("resourceId") or "")) or {}
        webhook_url = str(resource.get("webhookUrl") or payload.get("webhookUrl") or "").strip()
        if webhook_url:
            import httpx

            article = find_record(db, "articles", str(order.get("articleId") or "")) or {}
            try:
                response = httpx.post(
                    webhook_url,
                    json={
                        "orderId": order["id"],
                        "articleId": order.get("articleId") or "",
                        "articleTitle": order.get("articleTitle") or "",
                        "contentMarkdown": article.get("contentMarkdown") or "",
                        "title": article.get("title") or order.get("articleTitle") or "",
                        "keyword": article.get("keyword") or "",
                        "keywords": article.get("keywords") or [],
                        "resourceName": order.get("resourceName") or "",
                    },
                    headers={"Content-Type": "application/json"},
                    timeout=30,
                )
                response.raise_for_status()
                data = response.json() if response.content else {}
                backlink_url = str(data.get("url") or data.get("backlinkUrl") or data.get("link") or "").strip()
                provider_status = str(data.get("status") or "submitted")
                provider_review_status = str(data.get("reviewStatus") or "")
            except Exception as exc:
                if not get_settings().media_publish_fallback_mock:
                    raise
                provider_error = str(exc)
        elif not get_settings().media_publish_fallback_mock:
            raise ValueError("MEDIA_WEBHOOK_URL_NOT_CONFIGURED")

    if not backlink_url:
        order.update({
            "status": "review_required",
            "platformStatus": provider_status or "submitted",
            "reviewStatus": provider_review_status or "pending_public_visibility",
            "backlinkStatus": "blocked",
            "backlinkUrl": "",
            "errorCode": "PUBLICATION_URL_MISSING",
            "errorMessage": provider_error or "Publication accepted but no public article URL was returned.",
            "updatedAt": now_stamp(),
        })
        save_record(db, "mediaOrders", order)
        audit_event(db, "media.publication_pending", "mediaOrders", order["id"], {
            "reason": "PUBLICATION_URL_MISSING",
            "platformStatus": order["platformStatus"],
        })
        return {"mediaOrder": order, "indexSubmission": None, "task": None}

    if not is_public_http_url(backlink_url):
        order.update({
            "status": "review_required",
            "platformStatus": provider_status or "submitted",
            "reviewStatus": "pending_public_visibility",
            "backlinkStatus": "blocked",
            "backlinkUrl": "",
            "errorCode": "PUBLICATION_URL_INVALID",
            "errorMessage": "The media provider returned an invalid public article URL.",
            "updatedAt": now_stamp(),
        })
        save_record(db, "mediaOrders", order)
        audit_event(db, "media.publication_pending", "mediaOrders", order["id"], {
            "reason": "PUBLICATION_URL_INVALID",
        })
        return {"mediaOrder": order, "indexSubmission": None, "task": None}

    order.update({
        "status": "succeeded",
        "platformStatus": provider_status or order.get("platformStatus") or "published",
        "reviewStatus": provider_review_status,
        "backlinkStatus": "generated",
        "backlinkUrl": backlink_url,
        "errorCode": "",
        "errorMessage": "",
        "updatedAt": now_stamp(),
    })
    save_record(db, "mediaOrders", order)
    audit_event(db, "media.backlink_published", "mediaOrders", order["id"], {
        "backlinkUrl": backlink_url,
    })
    submission = None
    if payload.get("submitIndex") is True:
        submission = create_index_submission(db, {
            "articleId": order.get("articleId") or "",
            "articleTitle": order["articleTitle"],
            "provider": payload.get("provider") or "IndexNow",
            "source": "media-order",
            "sourceType": "media",
            "sourceId": order["id"],
            "url": backlink_url,
        })
    task = None
    if create_task_record and submission:
        task = create_task(db, "media-backlink-index", f"Media backlink index: {order['articleTitle']}", {
            "mediaOrderId": order["id"],
            "indexSubmissionId": submission["id"],
        }, "media")
    return {"mediaOrder": order, "indexSubmission": submission, "task": task}
