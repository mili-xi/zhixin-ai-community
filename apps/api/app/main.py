from __future__ import annotations

import hashlib
import secrets
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .auth.context import actor_scope, current_owner_id
from .auth.middleware import AuthenticationMiddleware
from .auth.security import hash_secret
from .config import csv_setting, get_settings
from .credential_health import (
    credential_check_hours,
    credential_retry_at,
    preserve_editor_token_expiry,
    next_credential_check_at,
)
from .database import SessionLocal, get_db, init_db
from .desktop_channels import (
    DESKTOP_DEVICE_LIVE_SECONDS,
    active_media_account_binding,
    adopt_media_account_binding_for_live_device,
    desktop_command_target_device_is_live,
    desktop_device_is_live,
    owner_live_channel_device,
    point_media_account_binding_at_device,
    resolve_media_account_channel_device,
)
from .desktop_identity import (
    claim_owner_binding,
    public_desktop_device,
    public_owner_binding,
    require_desktop_command_device_owner,
    require_desktop_agent_device,
    require_desktop_device_for_actor,
)
from .queue import queue_client
from .knowledge import parse_tags
from .llm import (
    build_deepseek_request_payload,
    draft_article_type_with_deepseek,
    draft_generation_rule_with_deepseek,
    generate_article_with_deepseek,
)
from .routes.auth import router as auth_router
from .routes.public_snapshot import router as public_snapshot_router
from .scraping import scrapling_status
from .search_index_provider import SearchIndexService
from .service import (
    BROWSER_VERIFIED_PUBLICATION_PLATFORMS,
    INDEX_PROVIDERS,
    PUBLICATION_DISCOVERY_PLATFORMS,
    article_is_locked_after_publish,
    assert_article_editable,
    audit_event,
    build_writer_context,
    claim_article_publish,
    clean_strings,
    create_ai_article,
    create_article,
    create_generic,
    create_index_submission,
    create_media_order,
    create_notification_from_payload,
    create_seo_provider_config,
    create_publish_job,
    create_task,
    default_by_kind,
    delete_articles,
    desktop_asset_cleanup_keep_profile_keys,
    ensure_writer_defaults,
    failure_center,
    failure_detail,
    find_record,
    get_record,
    health_check_seo_provider_config,
    blocking_image_evidence_issues,
    image_publication_evidence_public_blocker,
    is_private_creator_review_url,
    list_canonical_media_accounts,
    list_notifications,
    log_task_event,
    list_records,
    dashboard_task_records,
    dashboard_running_publish_count,
    list_desktop_command_records,
    list_seo_provider_configs,
    make_id,
    mark_notification_read,
    media_order_account_id,
    now_stamp,
    normalize_legacy_index_submissions,
    parse_desktop_command_timestamp,
    patch_record,
    patch_seo_provider_config,
    PUBLIC_ONLY_IMAGE_EVIDENCE_STAGES,
    publication_discovery_required,
    queue_article_media_publish_command,
    queue_index_submission,
    queue_media_publication_discovery,
    recover_public_only_image_publication_evidence,
    resolve_media_account,
    retry_auto_publish_failures,
    retry_failed_task,
    retry_task,
    save_record,
    search_knowledge_chunks,
    sortable_timestamp,
    score_article,
    supersede_duplicate_media_accounts,
    sync_auto_publish_task_status,
    batch_mark_notifications,
    candidate_publication_url_is_publishable,
    verify_media_order_publication,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    with SessionLocal() as db:
        supersede_duplicate_media_accounts(db)
        normalize_legacy_index_submissions(db)
        ensure_writer_defaults(db)
    from .mcp_server import mcp_transport
    async with mcp_transport.lifespan():
        yield


settings = get_settings()
app = FastAPI(title=settings.api_title, lifespan=lifespan)
from .video_publishing import router as video_router, handle_video_event, VideoUploadLimitMiddleware, video_command_supported_by_device
app.include_router(video_router)
from .mcp_access import router as mcp_access_router
from .mcp_server import mcp_transport, upload_router as mcp_upload_router
app.include_router(mcp_access_router)
app.include_router(mcp_upload_router)
app.add_route("/mcp", mcp_transport, methods=["GET", "POST", "DELETE"])
app.add_route("/mcp/", mcp_transport, methods=["GET", "POST", "DELETE"])
app.add_middleware(VideoUploadLimitMiddleware)
app.include_router(auth_router)
app.include_router(public_snapshot_router)
app.add_middleware(AuthenticationMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=csv_setting(settings.auth_allowed_origins),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(
    TrustedHostMiddleware,
    allowed_hosts=csv_setting(settings.auth_trusted_hosts),
)

upload_root = Path(settings.upload_dir)
if not upload_root.is_absolute():
    upload_root = Path.cwd() / upload_root
upload_root.mkdir(parents=True, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=str(upload_root)), name="uploads")


@app.get("/api/ai/providers/status")
def ai_provider_status() -> dict:
    settings = get_settings()
    gemini_configured = bool(settings.gemini_api_key) and not settings.gemini_offline_mode
    deepseek_configured = bool(settings.deepseek_api_key) and not settings.deepseek_offline_mode
    configured = gemini_configured
    image_is_step = settings.article_image_provider == "step"
    step_configured = image_is_step and bool(settings.step_api_key)
    mode = "live" if configured else "offline" if settings.gemini_offline_mode else "unconfigured"
    text_is_deepseek = settings.article_text_provider == "deepseek"
    text_configured = deepseek_configured if text_is_deepseek else gemini_configured
    text_offline = settings.deepseek_offline_mode if text_is_deepseek else settings.gemini_offline_mode
    text_mode = "live" if text_configured else "offline" if text_offline else "unconfigured"
    dataforseo_configured = bool(settings.dataforseo_login and settings.dataforseo_password)
    return {
        "text": {
            "provider": "deepseek" if text_is_deepseek else "gemini",
            "model": settings.deepseek_model if text_is_deepseek else settings.gemini_text_model,
            "configured": text_configured,
            "mode": text_mode,
        },
        "image": {
            "provider": "stepfun" if image_is_step else "gemini",
            "model": settings.step_image_model if image_is_step else settings.gemini_image_model,
            "configured": step_configured if image_is_step else configured,
            "mode": "live" if step_configured else "unconfigured" if image_is_step else mode,
        },
        "fallback": {
            "provider": "deepseek",
            "model": settings.deepseek_model,
            "configured": deepseek_configured,
        },
        "serp": {
            "provider": "dataforseo" if dataforseo_configured else ("http" if settings.seo_provider_base_url else "none"),
            "configured": dataforseo_configured or bool(settings.seo_provider_base_url),
            "engine": "Google" if dataforseo_configured else "custom",
            "hint": (
                "已接 DataForSEO，点分析会真采 Google 搜索结果"
                if dataforseo_configured
                else "未配置 DataForSEO，SERP 分析采不到真实竞品"
            ),
        },
        "knowledgeFetch": {
            **scrapling_status(),
            "mode": settings.knowledge_fetch_mode,
            "stealth": settings.knowledge_fetch_stealth,
        },
    }


@app.post("/api/generation-rules/ai-draft")
async def generation_rule_ai_draft(request: Request) -> dict:
    """Use project DeepSeek key to fill generation-rule form fields."""
    payload = await body_json(request)
    draft = draft_generation_rule_with_deepseek(payload)
    return {"draft": draft, "provider": "deepseek"}


@app.post("/api/article-types/ai-draft")
async def article_type_ai_draft(request: Request) -> dict:
    """Use project DeepSeek key to fill article-type form fields."""
    payload = await body_json(request)
    draft = draft_article_type_with_deepseek(payload)
    return {"draft": draft, "provider": "deepseek"}


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "service": "zhixin-ai-api"}


@app.get("/api/queues/health")
def queue_health() -> dict:
    return queue_client.health()


async def body_json(request: Request) -> dict[str, Any]:
    try:
        value = await request.json()
    except Exception:
        return {}
    return value if isinstance(value, dict) else {}


def iso_minutes_from_now(minutes: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(minutes=minutes)).isoformat()


def media_login_url(platform: str) -> str:
    urls = {
        "douyin": "https://creator.douyin.com/",
        "zhihu": "https://www.zhihu.com/signin",
        "baijiahao": "https://baijiahao.baidu.com/",
        "wechat": "https://mp.weixin.qq.com/",
        "sohu": "https://mp.sohu.com/",
        "csdn": "https://mp.csdn.net/",
        "netease": "https://mp.163.com/",
        "penguin": "https://om.qq.com/",
        "toutiao": "https://mp.toutiao.com/profile_v4/",
        "jianshu": "https://www.jianshu.com/sign_in",
    }
    return urls.get(platform, "about:blank")


def media_platform_fields(platform: str) -> list[str]:
    fields = {
        "douyin": ["视频", "文案", "封面"],
        "baijiahao": ["标题", "封面", "正文", "原创声明"],
        "wechat": ["标题", "封面", "正文", "摘要"],
        "zhihu": ["标题", "正文", "话题"],
        "sohu": ["标题", "正文", "分类"],
        "csdn": ["标题", "正文", "分类", "标签", "封面"],
        "netease": ["标题", "正文", "分类", "封面"],
        "penguin": ["标题", "正文", "分类", "封面", "原创声明"],
        "toutiao": ["标题", "正文", "分类", "封面", "原创声明"],
        "jianshu": ["标题", "正文", "文集", "标签"],
    }
    return fields.get(platform, ["标题", "正文"])


def artifact_fingerprint(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def public_auth_artifact(artifact: dict | None) -> dict | None:
    if not artifact:
        return None
    hidden_keys = {
        "cookies",
        "localStorage",
        "sessionStorage",
        "encryptedCookies",
        "encryptedLocalStorage",
        "encryptedSessionStorage",
    }
    return {key: value for key, value in artifact.items() if key not in hidden_keys}


SENSITIVE_SNAPSHOT_KEY_NAMES = {
    "authorization",
    "authheader",
    "password",
    "secret",
    "token",
    "accesstoken",
    "refreshtoken",
    "encryptedcookies",
    "encryptedlocalstorage",
    "encryptedsessionstorage",
    "localstorage",
    "sessionstorage",
}


def snapshot_key_is_sensitive(key: object) -> bool:
    normalized = str(key or "").replace("_", "").replace("-", "").lower()
    if normalized == "strongcookiepresent":
        return False
    return normalized in SENSITIVE_SNAPSHOT_KEY_NAMES or "cookie" in normalized


def sanitize_snapshot_value(value: object, depth: int = 0) -> object:
    if depth > 4:
        return ""
    if isinstance(value, dict):
        return {
            str(key): sanitize_snapshot_value(item, depth + 1)
            for key, item in value.items()
            if not snapshot_key_is_sensitive(key)
        }
    if isinstance(value, list):
        return [sanitize_snapshot_value(item, depth + 1) for item in value[:50]]
    if isinstance(value, bool) or isinstance(value, int) or isinstance(value, float):
        return value
    if value is None:
        return ""
    return str(value)[:1000]


def sanitize_platform_config(value: object) -> dict:
    if not isinstance(value, dict) or not value:
        return {}
    sanitized = sanitize_snapshot_value(value)
    if not isinstance(sanitized, dict):
        return {}
    sanitized["schemaVersion"] = int(sanitized.get("schemaVersion") or 1)
    sanitized["fetchedAt"] = str(sanitized.get("fetchedAt") or datetime.now(timezone.utc).isoformat())
    return sanitized


def sanitize_platform_capabilities(value: object) -> dict:
    if not isinstance(value, dict) or not value:
        return {}
    sanitized = sanitize_snapshot_value(value)
    if not isinstance(sanitized, dict):
        return {}
    sanitized["schemaVersion"] = int(sanitized.get("schemaVersion") or 1)
    sanitized["fetchedAt"] = str(sanitized.get("fetchedAt") or datetime.now(timezone.utc).isoformat())
    sanitized["canPublishArticle"] = sanitized.get("canPublishArticle") is True
    sanitized["canUploadImages"] = sanitized.get("canUploadImages") is True
    if isinstance(sanitized.get("requiredFields"), list):
        sanitized["requiredFields"] = [str(item) for item in sanitized["requiredFields"][:20] if str(item).strip()]
    return sanitized


def require_desktop_device(db: Session, device_id: str, device_token: str = "") -> dict:
    return require_desktop_agent_device(db, device_id, device_token)


def authorization_evidence_platform_ready(platform: str, evidence: dict) -> bool:
    current_url = str(evidence.get("currentUrl") or "")
    page_title = str(evidence.get("pageTitle") or "")
    page_text = str(evidence.get("pageText") or evidence.get("text") or "")
    combined = f"{current_url} {page_title} {page_text}".lower()
    if platform == "netease":
        if "mp.163.com" not in current_url.lower():
            return False
        if "login" in current_url.lower() or "reg.163.com" in combined:
            return False
        workspace_signals = [
            "content management",
            "article management",
            "write article",
            "publish",
            "创作中心",
            "内容管理",
            "发布",
            "写文章",
            "文章管理",
            "草稿",
        ]
        return any(signal.lower() in combined for signal in workspace_signals)
    return True


def clean_authorization_evidence(value: object, platform: str = "") -> dict:
    if not isinstance(value, dict):
        raise HTTPException(status_code=400, detail="AUTHORIZATION_EVIDENCE_REQUIRED")
    evidence = {
        "strongCookiePresent": value.get("strongCookiePresent") is True,
        "workspaceReady": value.get("workspaceReady") is True,
        "currentUrl": str(value.get("currentUrl") or ""),
        "pageTitle": str(value.get("pageTitle") or ""),
        "pageText": str(value.get("pageText") or value.get("text") or "")[:1000],
        "checkedAt": str(value.get("checkedAt") or now_stamp()),
    }
    if (
        not evidence["strongCookiePresent"]
        or not evidence["workspaceReady"]
        or not authorization_evidence_platform_ready(platform, evidence)
    ):
        raise HTTPException(status_code=400, detail="AUTHORIZATION_EVIDENCE_REQUIRED")
    return evidence


def authorization_evidence_is_valid(value: object) -> bool:
    return isinstance(value, dict) and value.get("strongCookiePresent") is True and value.get("workspaceReady") is True


def media_account_is_authorized(db: Session, account: dict) -> bool:
    if account.get("status") != "active" or account.get("credentialStatus") != "active":
        return False
    artifact_id = str(account.get("authArtifactId") or "")
    if not artifact_id:
        return False
    artifact = find_record(db, "mediaAuthArtifacts", artifact_id)
    return bool(artifact and artifact.get("status") == "active" and authorization_evidence_is_valid(artifact.get("authorizationEvidence")))


def queue_media_account_session_validation(db: Session, account_id: str, source: str = "manual") -> dict:
    account = resolve_media_account(db, account_id)
    account_id = account["id"]
    if not account.get("authArtifactId"):
        raise HTTPException(status_code=400, detail="MEDIA_ACCOUNT_ARTIFACT_REQUIRED")
    binding = active_media_account_binding(db, account_id)
    if not binding or not binding.get("deviceId"):
        raise HTTPException(status_code=400, detail="MEDIA_ACCOUNT_DEVICE_BINDING_REQUIRED")
    channel_device_id = resolve_media_account_channel_device(db, str(binding.get("deviceId") or ""))
    binding = point_media_account_binding_at_device(db, account_id, channel_device_id) or binding
    active_command = next((
        item for item in reversed(list_records(db, "desktopCommands"))
        if item.get("type") == "validate_session"
        and item.get("mediaAccountId") == account_id
        and item.get("status") in {"queued", "running"}
        and desktop_command_target_device_is_live(db, item)
    ), None)
    if active_command:
        return {"queued": True, "deduplicated": True, "desktopCommand": active_command}
    command = save_record(db, "desktopCommands", {
        "id": make_id("desktopCommands"),
        "deviceId": binding.get("deviceId") or "",
        "type": "validate_session",
        "mediaAccountId": account_id,
        "payload": {
            "platform": account.get("platform") or "",
            "profileKey": account.get("profileKey") or account_id,
            "source": source,
        },
        "status": "queued",
        "result": {},
        "errorMessage": "",
        "createdAt": now_stamp(),
        "updatedAt": now_stamp(),
    })
    audit_event(db, "desktop_command.create", "desktopCommands", command["id"], {
        "type": "validate_session",
        "deviceId": command.get("deviceId"),
        "source": source,
    })
    return {"queued": True, "deduplicated": False, "desktopCommand": command}


def desktop_launch_url(session_id: str) -> str:
    return f"zhixin-ai://media-auth/{session_id}"


def update_auth_session_for_event(db: Session, event: dict) -> dict | None:
    session_id = str(event.get("sessionId") or "")
    if not session_id:
        return None
    session = find_record(db, "mediaAuthSessions", session_id)
    if not session:
        return None
    status_by_event = {
        "desktop_ready": "desktop_ready",
        "browser_opened": "login_opened",
        "login_detected": "capturing",
        "capture_started": "capturing",
        "artifact_submitted": "submitted",
        "auth_failed": "failed",
        "auth_canceled": "canceled",
    }
    next_status = status_by_event.get(str(event.get("type") or ""))
    if not next_status:
        return session
    return patch_record(db, "mediaAuthSessions", session_id, {"status": next_status, "updatedAt": now_stamp()})


@app.get("/api/desktop-devices")
def get_desktop_devices(db: Session = Depends(get_db)) -> list[dict]:
    return list_records(db, "desktopDevices")


DESKTOP_CAPABILITY_KEYS = ("publish_video_v1", "publish_video_schedule_v1", "publish_article_v1")


@app.post("/api/desktop-devices/register")
async def register_desktop_device(request: Request, db: Session = Depends(get_db)) -> dict:
    payload = await body_json(request)
    device_token = secrets.token_urlsafe(24)
    owner_id = current_owner_id() or ""
    device = save_record(db, "desktopDevices", {
        "id": payload.get("id") or make_id("desktopDevices"),
        "deviceName": payload.get("deviceName") or "??AI???",
        "platform": payload.get("platform") or "windows",
        "appVersion": payload.get("appVersion") or "0.1.0",
        "capabilities": {key: isinstance(payload.get("capabilities"), dict) and payload["capabilities"].get(key) is True for key in DESKTOP_CAPABILITY_KEYS},
        "publicKey": payload.get("publicKey") or "",
        "deviceTokenHash": artifact_fingerprint(device_token),
        "boundOwnerId": owner_id,
        "ownerBoundAt": now_stamp() if owner_id else "",
        "status": "active",
        "lastSeenAt": now_stamp(),
        "createdAt": now_stamp(),
        "updatedAt": now_stamp(),
    })
    audit_event(db, "desktop_device.register", "desktopDevices", device["id"], {"platform": device.get("platform"), "appVersion": device.get("appVersion")})
    return {"device": public_desktop_device(device), "deviceToken": device_token}


@app.post("/api/desktop-owner-bindings", status_code=201)
def create_desktop_owner_binding(db: Session = Depends(get_db)) -> dict:
    owner_id = current_owner_id()
    if not owner_id:
        raise HTTPException(status_code=401, detail="AUTHENTICATION_REQUIRED")
    pairing_code = f"{secrets.randbelow(900000) + 100000}"
    binding = save_record(db, "desktopOwnerBindings", {
        "id": make_id("desktopOwnerBindings"),
        "deviceId": "",
        "pairingCodeHash": hash_secret(pairing_code),
        "status": "waiting_desktop",
        "expiresAt": iso_minutes_from_now(10),
        "createdAt": now_stamp(),
        "updatedAt": now_stamp(),
    })
    audit_event(db, "desktop_owner_binding.create", "desktopOwnerBindings", binding["id"], {})
    return {**public_owner_binding(binding), "pairingCode": pairing_code}


@app.post("/api/desktop-devices/{device_id}/owner-bindings/{binding_id}/claim")
async def claim_desktop_owner_binding(
    device_id: str,
    binding_id: str,
    request: Request,
    db: Session = Depends(get_db),
) -> dict:
    payload = await body_json(request)
    device_token = str(request.headers.get("x-device-token") or payload.get("deviceToken") or "")
    device, binding = claim_owner_binding(
        db,
        binding_id=binding_id,
        device_id=device_id,
        device_token=device_token,
        pairing_code=str(payload.get("pairingCode") or ""),
    )
    audit_event(
        db,
        "desktop_owner_binding.claim",
        "desktopOwnerBindings",
        binding_id,
        {"deviceId": device_id},
    )
    return {
        "device": public_desktop_device(device),
        "binding": public_owner_binding(binding),
    }


@app.post("/api/desktop-devices/{device_id}/verify")
async def verify_desktop_device(device_id: str, request: Request, db: Session = Depends(get_db)) -> dict:
    payload = await body_json(request)
    device_token = str(request.headers.get("x-device-token") or payload.get("deviceToken") or "")
    device = require_desktop_device(db, device_id, device_token)
    updated_device = patch_record(db, "desktopDevices", device_id, {"lastSeenAt": now_stamp(), "updatedAt": now_stamp()})
    audit_event(db, "desktop_device.verify", "desktopDevices", device["id"], {"platform": device.get("platform"), "appVersion": device.get("appVersion")})
    return {"device": public_desktop_device(updated_device)}


@app.get("/api/desktop-devices/{device_id}/asset-cleanup-keep-keys")
def get_desktop_asset_cleanup_keep_keys(device_id: str, request: Request, db: Session = Depends(get_db)) -> dict:
    device_token = str(request.headers.get("x-device-token") or "")
    require_desktop_device(db, device_id, device_token)
    # Read outside the device actor scope. The keep set deliberately spans every
    # owner, and this device's scope would narrow it to the bound owner only,
    # which protects too little for a delete operation.
    with actor_scope(None):
        keys = desktop_asset_cleanup_keep_profile_keys(db)
    return {"keepProfileKeys": sorted(keys)}


@app.get("/api/media-auth-sessions/{session_id}")
def get_media_auth_session(session_id: str, db: Session = Depends(get_db)) -> dict:
    session = get_record(db, "mediaAuthSessions", session_id)
    events = [item for item in list_records(db, "desktopEvents") if item.get("sessionId") == session_id]
    artifact = find_record(db, "mediaAuthArtifacts", str(session.get("artifactId") or ""))
    account = find_record(db, "mediaAccounts", str(session.get("mediaAccountId") or "")) if session.get("mediaAccountId") else None
    return {
        "session": session,
        "events": events[-10:],
        "artifact": public_auth_artifact(artifact),
        "mediaAccount": account,
        "desktopLaunchUrl": desktop_launch_url(session_id),
    }


@app.post("/api/media-auth-sessions")
async def create_media_auth_session_route(request: Request, db: Session = Depends(get_db)) -> dict:
    payload = await body_json(request)
    platform = str(payload.get("platform") or "zhihu")
    if payload.get("queueDesktopCommand"):
        # An open_auth command may only target a device bound to this actor.
        require_desktop_command_device_owner(db, str(payload.get("deviceId") or ""))
    session = save_record(db, "mediaAuthSessions", {
        "id": make_id("mediaAuthSessions"),
        "platform": platform,
        "mediaAccountId": payload.get("mediaAccountId") or "",
        "deviceId": payload.get("deviceId") or "",
        "pairingCode": f"{secrets.randbelow(900000) + 100000}",
        "nonce": secrets.token_urlsafe(18),
        "status": "waiting_desktop",
        "loginUrl": payload.get("loginUrl") or media_login_url(platform),
        "expiresAt": iso_minutes_from_now(15),
        "failureReason": "",
        "createdAt": now_stamp(),
        "updatedAt": now_stamp(),
    })
    desktop_command = None
    if payload.get("queueDesktopCommand"):
        desktop_command = save_record(db, "desktopCommands", {
            "id": make_id("desktopCommands"),
            "deviceId": payload.get("deviceId") or "",
            "type": "open_auth",
            "mediaAccountId": payload.get("mediaAccountId") or "",
            "payload": {
                "sessionId": session["id"],
                "pairingCode": session["pairingCode"],
                "platform": platform,
                "loginUrl": session["loginUrl"],
                "waitLoginMs": payload.get("waitLoginMs") or 300000,
                # Default false: close Chromium after login state is captured.
                "keepBrowserOpen": bool(payload.get("keepBrowserOpen", False)),
                "headless": False,
                "allowForeground": True,
            },
            "status": "queued",
            "result": {},
            "errorMessage": "",
            "createdAt": now_stamp(),
            "updatedAt": now_stamp(),
        })
    audit_event(db, "media_auth_session.create", "mediaAuthSessions", session["id"], {"platform": platform, "deviceId": session.get("deviceId")})
    result = {"session": session, "desktopLaunchUrl": desktop_launch_url(session["id"])}
    if desktop_command:
        result["desktopCommand"] = desktop_command
    return result


@app.post("/api/desktop-devices/{device_id}/media-auth-sessions/{session_id}/claim")
async def claim_media_auth_session(device_id: str, session_id: str, request: Request, db: Session = Depends(get_db)) -> dict:
    payload = await body_json(request)
    request_device_id = str(request.headers.get("x-device-id") or device_id)
    if request_device_id != device_id:
        raise HTTPException(status_code=403, detail="DESKTOP_DEVICE_ID_MISMATCH")
    device_token = str(request.headers.get("x-device-token") or payload.get("deviceToken") or "")
    device = require_desktop_device(db, device_id, device_token)
    session = get_record(db, "mediaAuthSessions", session_id)
    if device.get("status") != "active":
        raise HTTPException(status_code=400, detail="DESKTOP_DEVICE_NOT_ACTIVE")
    if str(payload.get("pairingCode") or "") != str(session.get("pairingCode") or ""):
        raise HTTPException(status_code=400, detail="PAIRING_CODE_INVALID")
    if session.get("status") not in {"waiting_desktop", "desktop_ready"}:
        raise HTTPException(status_code=400, detail="MEDIA_AUTH_SESSION_NOT_CLAIMABLE")
    updated_device = patch_record(db, "desktopDevices", device_id, {"lastSeenAt": now_stamp(), "updatedAt": now_stamp()})
    updated_session = patch_record(db, "mediaAuthSessions", session_id, {"deviceId": device_id, "status": "desktop_ready", "updatedAt": now_stamp()})
    event = save_record(db, "desktopEvents", {
        "id": make_id("desktopEvents"),
        "deviceId": device_id,
        "sessionId": session_id,
        "commandId": "",
        "type": "desktop_ready",
        "payload": {},
        "createdAt": now_stamp(),
    })
    audit_event(db, "media_auth_session.claim", "mediaAuthSessions", session_id, {"deviceId": device_id})
    return {"device": {key: value for key, value in updated_device.items() if key != "deviceTokenHash"}, "session": updated_session, "event": event}


@app.post("/api/desktop-events")
async def create_desktop_event(request: Request, db: Session = Depends(get_db)) -> dict:
    payload = await body_json(request)
    device_id = str(request.headers.get("x-device-id") or payload.get("deviceId") or "")
    device_token = str(request.headers.get("x-device-token") or payload.get("deviceToken") or "")
    device = require_desktop_device(db, device_id, device_token)
    patch = {"lastSeenAt": now_stamp(), "updatedAt": now_stamp()}
    # The agent used to report the appVersion frozen at registration, so a
    # device that upgraded its installer never moved off the version it first
    # registered with. Refresh it from the heartbeat only: every other event
    # payload is not version-shaped and must not be able to rewrite it.
    if str(payload.get("type") or "") == "heartbeat":
        reported_capabilities = (payload.get("payload") or {}).get("capabilities")
        patch["capabilities"] = {key: isinstance(reported_capabilities, dict) and reported_capabilities.get(key) is True for key in DESKTOP_CAPABILITY_KEYS}
        reported_version = str((payload.get("payload") or {}).get("appVersion") or "").strip()
        if reported_version and reported_version != str(device.get("appVersion") or ""):
            patch["appVersion"] = reported_version
    patch_record(db, "desktopDevices", device_id, patch)
    event = save_record(db, "desktopEvents", {
        "id": make_id("desktopEvents"),
        "deviceId": device_id,
        "sessionId": payload.get("sessionId") or "",
        "commandId": payload.get("commandId") or "",
        "type": payload.get("type") or "desktop_event",
        "payload": payload.get("payload") if isinstance(payload.get("payload"), dict) else {},
        "createdAt": now_stamp(),
    })
    session = update_auth_session_for_event(db, event)
    return {"event": event, "session": session}


@app.post("/api/media-auth-sessions/{session_id}/artifacts")
async def submit_media_auth_artifact(session_id: str, request: Request, db: Session = Depends(get_db)) -> dict:
    payload = await body_json(request)
    session = get_record(db, "mediaAuthSessions", session_id)
    artifact_payload = payload.get("artifact") if isinstance(payload.get("artifact"), dict) else {}
    encrypted_cookies = str(artifact_payload.get("cookies") or "")
    if not encrypted_cookies:
        raise HTTPException(status_code=400, detail="ENCRYPTED_COOKIES_REQUIRED")
    if session.get("status") in {"failed", "expired", "canceled"}:
        raise HTTPException(status_code=400, detail="MEDIA_AUTH_SESSION_CLOSED")
    platform = str(session.get("platform") or payload.get("platform") or "")
    authorization_evidence = clean_authorization_evidence(artifact_payload.get("authorizationEvidence"), platform)
    fingerprint = str(artifact_payload.get("fingerprint") or artifact_fingerprint(encrypted_cookies))
    credential_metadata = artifact_payload.get("credentialMetadata") if isinstance(artifact_payload.get("credentialMetadata"), dict) else {}
    platform_config = sanitize_platform_config(artifact_payload.get("platformConfig"))
    capabilities = sanitize_platform_capabilities(artifact_payload.get("capabilities"))
    verified_at = datetime.now(timezone.utc).isoformat()
    artifact = save_record(db, "mediaAuthArtifacts", {
        "id": make_id("mediaAuthArtifacts"),
        "sessionId": session_id,
        "mediaAccountId": session.get("mediaAccountId") or "",
        "platform": platform,
        "encryptedCookies": encrypted_cookies,
        "encryptedLocalStorage": artifact_payload.get("localStorage") or "",
        "encryptedSessionStorage": artifact_payload.get("sessionStorage") or "",
        "storageVersion": artifact_payload.get("storageVersion") or 1,
        "fingerprint": fingerprint,
        "accountName": payload.get("accountName") or "",
        "avatar": payload.get("avatar") or "",
        "authorizationEvidence": authorization_evidence,
        "credentialMetadata": credential_metadata,
        "platformConfig": platform_config,
        "capabilities": capabilities,
        "expiresAt": payload.get("expiresAt") or credential_metadata.get("credentialExpiresAt") or "",
        "lastVerifiedAt": verified_at,
        "status": "active",
        "createdAt": now_stamp(),
        "updatedAt": now_stamp(),
    })
    # Artifact persistence commits independently. Recheck under the same device
    # lock as logout before renewing the lease, so an in-flight upload cannot
    # revive an authorization that logout has already expired.
    db.expire_all()
    require_desktop_device_for_actor(db, str(session.get("deviceId") or payload.get("deviceId") or ""),
                                    str(request.headers.get("x-device-token") or ""))
    session = get_record(db, "mediaAuthSessions", session_id)
    if session.get("status") in {"failed", "expired", "canceled"}:
        raise HTTPException(status_code=400, detail="MEDIA_AUTH_SESSION_CLOSED")
    updated_session = patch_record(db, "mediaAuthSessions", session_id, {
        "status": "verified",
        # Capture can outlast the login lease; protect the remaining bind step.
        "expiresAt": iso_minutes_from_now(15),
        "artifactId": artifact["id"],
        "accountName": artifact.get("accountName") or "",
        "updatedAt": now_stamp(),
    })
    save_record(db, "desktopEvents", {
        "id": make_id("desktopEvents"),
        "deviceId": payload.get("deviceId") or session.get("deviceId") or "",
        "sessionId": session_id,
        "commandId": "",
        "type": "artifact_submitted",
        "payload": {"artifactId": artifact["id"], "fingerprint": fingerprint},
        "createdAt": now_stamp(),
    })
    audit_event(db, "media_auth_artifact.submit", "mediaAuthArtifacts", artifact["id"], {"sessionId": session_id, "platform": artifact.get("platform")})
    return {"session": updated_session, "artifact": public_auth_artifact(artifact)}


@app.post("/api/media-auth-sessions/{session_id}/bind")
async def bind_media_auth_session(session_id: str, request: Request, db: Session = Depends(get_db)) -> dict:
    payload = await body_json(request)
    session = get_record(db, "mediaAuthSessions", session_id)
    if session.get("status") not in {"verified", "bound"}:
        raise HTTPException(status_code=400, detail="MEDIA_AUTH_SESSION_NOT_VERIFIED")
    artifact = get_record(db, "mediaAuthArtifacts", str(session.get("artifactId") or ""))
    platform = str(session.get("platform") or artifact.get("platform") or "other")
    platform_key = platform.strip().lower()
    requested_account_id = str(session.get("mediaAccountId") or payload.get("mediaAccountId") or "")
    platform_config = artifact.get("platformConfig") if isinstance(artifact.get("platformConfig"), dict) else {}
    authenticated_uid = str(platform_config.get("accountId") or "").strip()
    if platform_key == "douyin" and not authenticated_uid:
        raise HTTPException(status_code=400, detail="MEDIA_ACCOUNT_IDENTITY_REQUIRED")
    current_account = None
    if requested_account_id and find_record(db, "mediaAccounts", requested_account_id):
        current_account = resolve_media_account(db, requested_account_id)
        if str(current_account.get("platform") or "").strip().lower() != platform_key:
            raise HTTPException(status_code=400, detail="MEDIA_ACCOUNT_PLATFORM_MISMATCH")
    if platform_key == "douyin" and requested_account_id:
        if current_account is None:
            raise HTTPException(status_code=404, detail="MEDIA_ACCOUNT_NOT_FOUND")
        existing_uid = str((current_account.get("platformConfig") or {}).get("accountId") or "").strip()
        if not existing_uid or existing_uid != authenticated_uid:
            raise HTTPException(status_code=409, detail="MEDIA_ACCOUNT_IDENTITY_MISMATCH")
    if current_account is None:
        current_account = next((
            account for account in list_canonical_media_accounts(db)
            if str(account.get("platform") or "").strip().lower() == platform_key
            and (platform_key != "douyin" or (
                str(account.get("ownerId") or "") == str(session.get("ownerId") or "")
                and str((account.get("platformConfig") or {}).get("accountId") or "").strip() == authenticated_uid
            ))
        ), None)
    all_platform_accounts = [
        account for account in list_records(db, "mediaAccounts")
        if str(account.get("platform") or "").strip().lower() == platform_key
            and (platform_key != "douyin" or (
                str(account.get("ownerId") or "") == str(session.get("ownerId") or "")
                and str((account.get("platformConfig") or {}).get("accountId") or "").strip() == authenticated_uid
            ))
    ]
    profile_key = str(payload.get("profileKey") or session.get("profileKey") or session_id)
    credential_metadata = artifact.get("credentialMetadata") if isinstance(artifact.get("credentialMetadata"), dict) else {}
    platform_config = artifact.get("platformConfig") if isinstance(artifact.get("platformConfig"), dict) else {}
    capabilities = artifact.get("capabilities") if isinstance(artifact.get("capabilities"), dict) else {}
    credential_expires_at = str(credential_metadata.get("credentialExpiresAt") or artifact.get("expiresAt") or "")
    verified_at = str(artifact.get("lastVerifiedAt") or datetime.now(timezone.utc).isoformat())
    account_payload = {
        "platform": platform,
        "name": payload.get("name") or artifact.get("accountName") or f"{session.get('platform') or '媒体'}账号",
        "accountName": artifact.get("accountName") or payload.get("accountName") or "",
        "avatar": artifact.get("avatar") or "",
        "status": "active",
        "fields": media_platform_fields(str(session.get("platform") or artifact.get("platform") or "")),
        "limit": payload.get("limit") or "",
        "cookies": "",
        "authArtifactId": artifact["id"],
        "profileKey": profile_key,
        "credentialFingerprint": artifact.get("fingerprint") or "",
        "credentialStatus": "active",
        "credentialExpiresAt": credential_expires_at,
        "lastVerifiedAt": verified_at,
        "nextCredentialCheckAt": next_credential_check_at(platform, credential_expires_at),
        "consecutiveAuthFailures": 0,
        "lastCheckedAt": now_stamp(),
        "lastError": "",
        "isCanonical": True,
        "supersededByAccountId": "",
        "supersededAt": "",
        "platformConfig": platform_config,
        "capabilities": capabilities,
        "createdAt": now_stamp(),
        "updatedAt": now_stamp(),
    }
    if current_account:
        media_account = save_record(db, "mediaAccounts", {
            **current_account,
            **account_payload,
            "id": current_account["id"],
            "createdAt": current_account.get("createdAt") or account_payload["createdAt"],
        })
    else:
        media_account = save_record(db, "mediaAccounts", {"id": make_id("mediaAccounts"), **account_payload})

    replaced_account_ids = {
        str(account.get("id") or "") for account in all_platform_accounts
        if account.get("id")
    }
    replaced_account_ids.add(media_account["id"])
    previous_artifact_ids = {
        str(account.get("authArtifactId") or "") for account in all_platform_accounts
        if account.get("authArtifactId")
    }
    for duplicate in all_platform_accounts:
        if duplicate.get("id") == media_account["id"]:
            continue
        patch_record(db, "mediaAccounts", duplicate["id"], {
            "status": "superseded",
            "credentialStatus": "revoked",
            "isCanonical": False,
            "supersededByAccountId": media_account["id"],
            "supersededAt": now_stamp(),
        })

    binding = save_record(db, "mediaAccountBindings", {
        "id": make_id("mediaAccountBindings"),
        "mediaAccountId": media_account["id"],
        "sessionId": session_id,
        "artifactId": artifact["id"],
        "deviceId": session.get("deviceId") or "",
        "platform": media_account.get("platform") or "",
        "profileKey": profile_key,
        "status": "active",
        "createdAt": now_stamp(),
        "updatedAt": now_stamp(),
    })
    for previous_binding in list_records(db, "mediaAccountBindings"):
        if (
            previous_binding.get("id") != binding["id"]
            and previous_binding.get("mediaAccountId") in replaced_account_ids
        ):
            if previous_binding.get("artifactId"):
                previous_artifact_ids.add(str(previous_binding["artifactId"]))
            if previous_binding.get("status") == "active":
                patch_record(db, "mediaAccountBindings", previous_binding["id"], {
                    "status": "superseded",
                    "supersededBy": binding["id"],
                })
    for previous_artifact in list_records(db, "mediaAuthArtifacts"):
        if previous_artifact.get("mediaAccountId") in replaced_account_ids:
            previous_artifact_ids.add(str(previous_artifact.get("id") or ""))
    for previous_artifact_id in previous_artifact_ids:
        if previous_artifact_id and previous_artifact_id != artifact["id"] and find_record(db, "mediaAuthArtifacts", previous_artifact_id):
            patch_record(db, "mediaAuthArtifacts", previous_artifact_id, {
                "status": "superseded",
                "supersededBy": artifact["id"],
            })
    updated_artifact = patch_record(db, "mediaAuthArtifacts", artifact["id"], {
        "mediaAccountId": media_account["id"],
        "profileKey": profile_key,
        "status": "active",
        "updatedAt": now_stamp(),
    })
    updated_session = patch_record(db, "mediaAuthSessions", session_id, {"status": "bound", "mediaAccountId": media_account["id"], "bindingId": binding["id"], "profileKey": profile_key, "updatedAt": now_stamp()})
    audit_event(db, "media_auth_session.bind", "mediaAuthSessions", session_id, {"mediaAccountId": media_account["id"], "artifactId": artifact["id"]})
    return {"session": updated_session, "mediaAccount": media_account, "binding": binding, "artifact": public_auth_artifact(updated_artifact)}


@app.post("/api/desktop-devices/{device_id}/media-accounts/{account_id}/artifact")
async def get_desktop_media_account_artifact(device_id: str, account_id: str, request: Request, db: Session = Depends(get_db)) -> dict:
    payload = await body_json(request)
    require_desktop_device(db, device_id, str(payload.get("deviceToken") or ""))
    account = get_record(db, "mediaAccounts", account_id)
    adopt_media_account_binding_for_live_device(db, account_id, device_id)
    binding = active_media_account_binding(db, account_id, device_id)
    if not binding:
        raise HTTPException(status_code=403, detail="MEDIA_ACCOUNT_DEVICE_BINDING_REQUIRED")
    artifact = get_record(db, "mediaAuthArtifacts", str(account.get("authArtifactId") or binding.get("artifactId") or ""))
    return {
        "mediaAccountId": account_id,
        "profileKey": account.get("profileKey") or binding.get("profileKey") or binding.get("sessionId") or "",
        "artifact": artifact,
    }


@app.post("/api/desktop-devices/{device_id}/media-accounts/{account_id}/artifacts/refresh")
async def refresh_desktop_media_account_artifact(device_id: str, account_id: str, request: Request, db: Session = Depends(get_db)) -> dict:
    payload = await body_json(request)
    require_desktop_device(db, device_id, str(payload.get("deviceToken") or ""))
    account = get_record(db, "mediaAccounts", account_id)
    if str(account.get("platform") or "").strip().lower() == "douyin":
        incoming = payload.get("artifact") or {}
        incoming_uid = str((incoming.get("platformConfig") or {}).get("accountId") or "").strip()
        existing_uid = str((account.get("platformConfig") or {}).get("accountId") or "").strip()
        if not incoming_uid or not existing_uid or incoming_uid != existing_uid:
            raise HTTPException(status_code=409, detail="MEDIA_ACCOUNT_IDENTITY_MISMATCH")
    adopt_media_account_binding_for_live_device(db, account_id, device_id)
    binding = active_media_account_binding(db, account_id, device_id)
    if not binding:
        raise HTTPException(status_code=403, detail="MEDIA_ACCOUNT_DEVICE_BINDING_REQUIRED")

    artifact_payload = payload.get("artifact") if isinstance(payload.get("artifact"), dict) else {}
    encrypted_cookies = str(artifact_payload.get("cookies") or artifact_payload.get("encryptedCookies") or "")
    if not encrypted_cookies:
        raise HTTPException(status_code=400, detail="ENCRYPTED_COOKIES_REQUIRED")
    platform = str(account.get("platform") or binding.get("platform") or "")
    authorization_evidence = clean_authorization_evidence(artifact_payload.get("authorizationEvidence"), platform)
    previous_artifact_id = str(account.get("authArtifactId") or binding.get("artifactId") or "")
    previous_artifact = find_record(db, "mediaAuthArtifacts", previous_artifact_id) if previous_artifact_id else None
    credential_metadata = artifact_payload.get("credentialMetadata") if isinstance(artifact_payload.get("credentialMetadata"), dict) else {}
    # A refreshed capture loses the editor's short-lived runtime token once the editor
    # cleans it from storage. Without this reconciliation the push would reset
    # credentialExpiresAt to the cookie-only expiry months ahead and mark the account
    # active again, hiding the real publishing deadline.
    credential_metadata = preserve_editor_token_expiry(
        credential_metadata,
        previous_artifact.get("credentialMetadata") if isinstance(previous_artifact, dict) else {},
    )
    credential_expires_at = str(credential_metadata.get("credentialExpiresAt") or artifact_payload.get("expiresAt") or "")
    platform_config = sanitize_platform_config(artifact_payload.get("platformConfig"))
    capabilities = sanitize_platform_capabilities(artifact_payload.get("capabilities"))
    verified_at = datetime.now(timezone.utc).isoformat()
    profile_key = str(payload.get("profileKey") or account.get("profileKey") or binding.get("profileKey") or binding.get("sessionId") or account_id)
    fingerprint = str(artifact_payload.get("fingerprint") or artifact_fingerprint(encrypted_cookies))
    artifact = save_record(db, "mediaAuthArtifacts", {
        "id": make_id("mediaAuthArtifacts"),
        "sessionId": binding.get("sessionId") or "",
        "mediaAccountId": account_id,
        "platform": platform,
        "profileKey": profile_key,
        "encryptedCookies": encrypted_cookies,
        "encryptedLocalStorage": artifact_payload.get("localStorage") or artifact_payload.get("encryptedLocalStorage") or "",
        "encryptedSessionStorage": artifact_payload.get("sessionStorage") or artifact_payload.get("encryptedSessionStorage") or "",
        "storageVersion": artifact_payload.get("storageVersion") or 2,
        "fingerprint": fingerprint,
        "accountName": account.get("accountName") or account.get("name") or "",
        "avatar": account.get("avatar") or "",
        "authorizationEvidence": authorization_evidence,
        "credentialMetadata": credential_metadata,
        "platformConfig": platform_config,
        "capabilities": capabilities,
        "expiresAt": credential_expires_at,
        "lastVerifiedAt": verified_at,
        "status": "active",
        "createdAt": now_stamp(),
        "updatedAt": now_stamp(),
    })
    if previous_artifact_id and previous_artifact:
        patch_record(db, "mediaAuthArtifacts", previous_artifact_id, {
            "status": "superseded",
            "supersededBy": artifact["id"],
            "updatedAt": now_stamp(),
        })
    updated_account = patch_record(db, "mediaAccounts", account_id, {
        "authArtifactId": artifact["id"],
        "profileKey": profile_key,
        "credentialFingerprint": fingerprint,
        "credentialStatus": "active",
        "status": "active",
        "credentialExpiresAt": credential_expires_at,
        "lastVerifiedAt": verified_at,
        "nextCredentialCheckAt": next_credential_check_at(platform, credential_expires_at),
        "consecutiveAuthFailures": 0,
        "lastCheckedAt": now_stamp(),
        "lastError": "",
        "platformConfig": platform_config or account.get("platformConfig") or {},
        "capabilities": capabilities or account.get("capabilities") or {},
        "updatedAt": now_stamp(),
    })
    updated_binding = patch_record(db, "mediaAccountBindings", binding["id"], {
        "artifactId": artifact["id"],
        "profileKey": profile_key,
        "updatedAt": now_stamp(),
    })
    session_id = str(binding.get("sessionId") or "")
    if session_id and find_record(db, "mediaAuthSessions", session_id):
        patch_record(db, "mediaAuthSessions", session_id, {
            "artifactId": artifact["id"],
            "profileKey": profile_key,
            "updatedAt": now_stamp(),
        })
    audit_event(db, "media_auth_artifact.refresh", "mediaAuthArtifacts", artifact["id"], {
        "mediaAccountId": account_id,
        "previousArtifactId": previous_artifact_id,
        "deviceId": device_id,
    })
    return {
        "artifact": public_auth_artifact(artifact),
        "mediaAccount": updated_account,
        "binding": updated_binding,
        "supersededArtifactId": previous_artifact_id,
    }


@app.get("/api/desktop-commands")
def get_desktop_commands(request: Request, db: Session = Depends(get_db)) -> list[dict]:
    device_id = str(request.headers.get("x-device-id") or "")
    device_token = str(request.headers.get("x-device-token") or "")
    device = require_desktop_device(db, device_id, device_token)
    return [
        command for command in list_desktop_command_records(db, device_id)
        if (not command.get("deviceId") or command.get("deviceId") == device_id)
        and video_command_supported_by_device(command, device)
    ]


@app.post("/api/desktop-commands")
async def create_desktop_command(request: Request, db: Session = Depends(get_db)) -> dict:
    payload = await body_json(request)
    command_type = str(payload.get("type") or "open_auth")
    if command_type == "publish_video":
        raise HTTPException(status_code=400, detail="USE_VIDEO_PUBLICATIONS_ENDPOINT")
    media_account_id = str(payload.get("mediaAccountId") or "")
    command_device_id = str(payload.get("deviceId") or "")
    if command_type == "validate_session":
        return queue_media_account_session_validation(db, media_account_id, str(payload.get("source") or "api"))["desktopCommand"]
    if command_type in {"publish_article", "discover_publication"}:
        account = resolve_media_account(db, media_account_id)
        media_account_id = account["id"]
        if not media_account_is_authorized(db, account):
            raise HTTPException(status_code=400, detail="MEDIA_ACCOUNT_NOT_AUTHORIZED")
        binding = active_media_account_binding(db, media_account_id)
        if not binding or not binding.get("deviceId"):
            raise HTTPException(status_code=400, detail="MEDIA_ACCOUNT_DEVICE_BINDING_REQUIRED")
        bound_device_id = resolve_media_account_channel_device(db, str(binding.get("deviceId") or ""))
        binding = point_media_account_binding_at_device(db, media_account_id, bound_device_id) or binding
        if command_device_id and command_device_id != bound_device_id:
            raise HTTPException(status_code=403, detail="DESKTOP_COMMAND_DEVICE_MISMATCH")
        command_device_id = bound_device_id
    command_payload = payload.get("payload") if isinstance(payload.get("payload"), dict) else {}
    if command_type in {"publish_article", "discover_publication"}:
        command_payload = {
            **command_payload,
            "headless": command_payload.get("headless", True) is not False,
            "keepBrowserOpen": bool(command_payload.get("keepBrowserOpen", False)),
            "allowForeground": bool(command_payload.get("allowForeground", False)),
        }
    elif command_type == "open_auth":
        command_payload = {
            **command_payload,
            "headless": False,
            "allowForeground": True,
            "keepBrowserOpen": bool(command_payload.get("keepBrowserOpen", False)),
        }
    if command_type == "open_auth" and command_device_id:
        # An open_auth command may only target a device bound to this actor.
        require_desktop_command_device_owner(db, command_device_id)
    command = save_record(db, "desktopCommands", {
        "id": make_id("desktopCommands"),
        "deviceId": command_device_id,
        "type": command_type,
        "mediaAccountId": media_account_id,
        "payload": command_payload,
        "status": "queued",
        "result": {},
        "errorMessage": "",
        "createdAt": now_stamp(),
        "updatedAt": now_stamp(),
    })
    audit_event(db, "desktop_command.create", "desktopCommands", command["id"], {"type": command_type, "deviceId": command.get("deviceId")})
    return command


@app.get("/api/desktop-commands/{command_id}")
def get_desktop_command(command_id: str, request: Request, db: Session = Depends(get_db)) -> dict:
    command = get_record(db, "desktopCommands", command_id)
    device_id = str(request.headers.get("x-device-id") or "")
    if device_id:
        device = require_desktop_device(db, device_id, str(request.headers.get("x-device-token") or ""))
        if command.get("deviceId") and command["deviceId"] != device_id:
            raise HTTPException(status_code=403, detail="DESKTOP_COMMAND_DEVICE_MISMATCH")
        if not video_command_supported_by_device(command, device):
            raise HTTPException(status_code=409, detail="DESKTOP_VIDEO_SCHEDULE_UPGRADE_REQUIRED" if (command.get("payload") or {}).get("publishMode") == "scheduled" else "DESKTOP_VIDEO_UPGRADE_REQUIRED")
    return command


def sanitize_image_publication_evidence(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}

    def copy_present(source: dict, keys: list[str]) -> dict:
        return {key: source[key] for key in keys if key in source}

    def sanitize_image(image: Any) -> dict[str, Any] | None:
        if not isinstance(image, dict):
            return None
        image_url = str(image.get("platformImageUrl") or "").strip()
        parsed = urlsplit(image_url)
        if parsed.scheme != "https" or not parsed.hostname:
            return None
        return copy_present(image, [
            "assetId",
            "sectionId",
            "position",
            "platformImageId",
            "platformImageUrl",
            "loaded",
        ])

    def sanitize_stage(stage: Any) -> dict[str, Any]:
        if not isinstance(stage, dict):
            return {}
        sanitized = copy_present(stage, ["status", "expectedCount", "observedCount", "verifiedCount", "blocker", "unverifiableReason"])
        sanitized["images"] = [
            clean_image
            for image in stage.get("images") or []
            if (clean_image := sanitize_image(image)) is not None
        ]
        return sanitized

    sanitized = copy_present(value, ["version", "status", "expectedCount", "issues", "verifiedAt"])
    expected = []
    for item in value.get("expected") or []:
        if isinstance(item, dict):
            expected.append(copy_present(item, ["assetId", "sectionId", "position", "idempotencyKey"]))
    if "expected" in value:
        sanitized["expected"] = expected
    for stage_name in ["upload", "draft", "public"]:
        if stage_name in value:
            sanitized[stage_name] = sanitize_stage(value.get(stage_name))
    return sanitized


def image_publication_evidence_matches_order(order: dict, evidence: dict) -> bool:
    existing = order.get("imagePublicationEvidence") if isinstance(order.get("imagePublicationEvidence"), dict) else {}
    expected = existing.get("expected") if isinstance(existing.get("expected"), list) else []
    expected_identities = [
        (str(item.get("assetId") or ""), str(item.get("sectionId") or ""), int(item.get("position") or 0))
        for item in expected
        if isinstance(item, dict)
    ]
    if not expected_identities:
        return True
    if int(evidence.get("expectedCount") or 0) != len(expected_identities):
        return False
    # A public page the platform would not show us leaves the evidence in
    # "review_required" with only PUBLIC_IMAGE_UNVERIFIABLE, which is a signal gap and
    # has to survive this check so the order can still be settled from the desktop page.
    if (
        str(evidence.get("status") or "") not in {"verified", "review_required"}
        or blocking_image_evidence_issues(evidence)
    ):
        return False
    evidence_expected = [
        (str(item.get("assetId") or ""), str(item.get("sectionId") or ""), int(item.get("position") or 0))
        for item in evidence.get("expected") or []
        if isinstance(item, dict)
    ]
    if evidence_expected != expected_identities:
        return False
    for stage_name in ["upload", "draft", "public"]:
        stage = evidence.get(stage_name) if isinstance(evidence.get(stage_name), dict) else {}
        stage_status = str(stage.get("status") or "")
        if stage_name in PUBLIC_ONLY_IMAGE_EVIDENCE_STAGES and str(stage.get("status") or "") == "not_observed":
            continue
        if stage_name == "public" and stage_status == "unverifiable":
            continue
        identities = [
            (str(item.get("assetId") or ""), str(item.get("sectionId") or ""), int(item.get("position") or 0))
            for item in stage.get("images") or []
            if isinstance(item, dict)
        ]
        if (
            stage.get("status") != "verified"
            or int(stage.get("verifiedCount") or 0) != len(expected_identities)
            or identities != expected_identities
        ):
            return False
    return True



def publication_discovery_failure_message(error_message: str) -> str:
    text = str(error_message or "").strip()
    normalized = text.lower()
    browser_runtime_missing = (
        "launchpersistentcontext" in normalized
        and ("executable doesn't exist" in normalized or "playwright install" in normalized)
    )
    if browser_runtime_missing:
        return "\u684c\u9762\u7aef\u6d4f\u89c8\u5668\u7ec4\u4ef6\u4e0d\u53ef\u7528\uff0c\u8bf7\u66f4\u65b0\u684c\u9762\u7aef\u540e\u91cd\u65b0\u53d1\u73b0\u516c\u5f00 URL\u3002"
    return text or "\u516c\u5f00 URL \u53d1\u73b0\u5931\u8d25\uff0c\u7b49\u5f85\u4e0b\u6b21\u91cd\u8bd5\u3002"


REJECTED_PUBLICATION_STATUSES = {"rejected", "failed", "publish_failed", "review_failed"}
# Platform statuses that mean the article was accepted (published or queued for review),
# so a later failed desktop event must not relabel the order as a publish failure.
ACCEPTED_PUBLICATION_STATUSES = {
    "draft_saved",
    "submitted_for_review",
    "published",
    "published_restricted",
    "pending_public_visibility",
    "reviewing",
    "manual_verification_required",
}


def publication_result_is_rejected(result: dict) -> bool:
    platform_status = str(result.get("platformStatus") or "").strip().lower()
    review_status = str(result.get("reviewStatus") or "").strip().lower()
    return platform_status in REJECTED_PUBLICATION_STATUSES or review_status in REJECTED_PUBLICATION_STATUSES


def publication_rejected_message(result: dict) -> str:
    return str(result.get("message") or result.get("errorMessage") or "平台审核未通过，未生成公开文章 URL。")


@app.post("/api/desktop-commands/{command_id}/events")
async def update_desktop_command_from_event(command_id: str, request: Request, db: Session = Depends(get_db)) -> dict:
    payload = await body_json(request)
    command = get_record(db, "desktopCommands", command_id)
    event_type = str(payload.get("type") or "")
    device_id = str(request.headers.get("x-device-id") or payload.get("deviceId") or "")
    device_token = str(request.headers.get("x-device-token") or payload.get("deviceToken") or "")
    device = require_desktop_device(db, device_id, device_token)
    command_device_id = str(command.get("deviceId") or "")
    if command_device_id and command_device_id != device_id:
        raise HTTPException(status_code=403, detail="DESKTOP_COMMAND_DEVICE_MISMATCH")
    if command.get("type") == "publish_video" or (command.get("type") == "discover_publication" and (command.get("payload") or {}).get("videoPublicationId")):
        video_event_payload = payload.get("payload") if isinstance(payload.get("payload"), dict) else {}
        if command.get("type") == "publish_video" and (command.get("payload") or {}).get("publishMode") == "scheduled" and event_type in {"accepted", "running", "publish_started"}:
            execution_capabilities = video_event_payload.get("executionCapabilities")
            if not isinstance(execution_capabilities, dict) or any(execution_capabilities.get(key) is not True for key in ("publish_video_v1", "publish_video_schedule_v1")):
                raise HTTPException(status_code=409, detail="DESKTOP_VIDEO_SCHEDULE_UPGRADE_REQUIRED")
        if event_type in {"accepted", "running", "publish_started", "publish_progress"} and not video_command_supported_by_device(command, device):
            raise HTTPException(status_code=409, detail="DESKTOP_VIDEO_SCHEDULE_UPGRADE_REQUIRED" if (command.get("payload") or {}).get("publishMode") == "scheduled" else "DESKTOP_VIDEO_UPGRADE_REQUIRED")
        return handle_video_event(db, command, event_type, video_event_payload)
    allowed_events = {
        "open_auth": {"accepted", "running", "auth_succeeded", "auth_failed"},
        "publish_article": {"accepted", "running", "publish_started", "publish_progress", "manual_verification_required", "publish_succeeded", "publish_failed"},
        "discover_publication": {"accepted", "running", "publication_discovery_succeeded", "publication_discovery_failed"},
        "validate_session": {"accepted", "running", "session_validation_succeeded", "session_validation_failed"},
        # publish_failed is the catch-all an older agent maps every unknown
        # command type onto, so it has to stay claimable or a legacy device
        # would leave a queued cleanup stuck in running forever.
        "cleanup_assets": {"accepted", "running", "cleanup_succeeded", "cleanup_failed", "publish_failed"},
    }.get(str(command.get("type") or ""), {"accepted", "running"})
    if event_type not in allowed_events:
        raise HTTPException(status_code=400, detail="DESKTOP_COMMAND_EVENT_INVALID")
    if not command_device_id:
        command = patch_record(db, "desktopCommands", command_id, {"deviceId": device_id, "updatedAt": now_stamp()})
    event_payload = payload.get("payload") if isinstance(payload.get("payload"), dict) else {}
    event_terminal_status = "succeeded" if event_type.endswith("_succeeded") else "failed" if event_type.endswith("_failed") else ""
    if command.get("status") in {"succeeded", "failed", "canceled"}:
        if event_terminal_status != command.get("status"):
            raise HTTPException(status_code=409, detail="DESKTOP_COMMAND_ALREADY_TERMINAL")
        event = save_record(db, "desktopEvents", {
            "id": make_id("desktopEvents"),
            "deviceId": device_id,
            "sessionId": payload.get("sessionId") or "",
            "commandId": command_id,
            "type": event_type,
            "payload": event_payload,
            "createdAt": now_stamp(),
        })
        existing_result = command.get("result") if isinstance(command.get("result"), dict) else {}
        media_order_id = str(existing_result.get("mediaOrderId") or "")
        submission_id = str(existing_result.get("indexSubmissionId") or "")
        media_order = find_record(db, "mediaOrders", media_order_id) if media_order_id else None
        index_submission = find_record(db, "indexSubmissions", submission_id) if submission_id else None
        audit_event(db, "desktop_command.event_replayed", "desktopCommands", command_id, {"type": event_type, "status": command.get("status")})
        return {"command": command, "event": event, "mediaOrder": media_order, "indexSubmission": index_submission}
    next_status = command.get("status")
    error_message = command.get("errorMessage") or ""
    result = command.get("result") if isinstance(command.get("result"), dict) else {}
    if event_type.endswith("_succeeded"):
        next_status = "succeeded"
        result = {**result, **event_payload}
    elif event_type.endswith("_failed"):
        next_status = "failed"
        error_message = str(event_payload.get("errorMessage") or payload.get("errorMessage") or "DESKTOP_COMMAND_FAILED")
        result = {**result, **{key: value for key, value in event_payload.items() if key != "errorMessage"}}
    elif event_type in {"accepted", "running", "publish_started", "publish_progress"}:
        next_status = "running"
    elif event_type == "manual_verification_required":
        next_status = "running"
        result = {
            **result,
            **event_payload,
            "platformStatus": "manual_verification_required",
            "message": event_payload.get("message") or "请在弹出的平台窗口完成安全验证，验证通过后会继续发布。",
        }
    updated_command = patch_record(db, "desktopCommands", command_id, {"status": next_status, "result": result, "errorMessage": error_message, "updatedAt": now_stamp()})
    event = save_record(db, "desktopEvents", {
        "id": make_id("desktopEvents"),
        "deviceId": device_id,
        "sessionId": payload.get("sessionId") or "",
        "commandId": command_id,
        "type": event_type or "desktop_command_event",
        "payload": event_payload,
        "createdAt": now_stamp(),
    })
    auth_error_text = f"{error_message} {event_payload.get('errorMessage') or ''} {event_payload.get('platformStatus') or ''}".upper()
    if command.get("type") == "validate_session":
        account = find_record(db, "mediaAccounts", str(command.get("mediaAccountId") or ""))
        if account and next_status == "succeeded":
            metadata = event_payload.get("credentialMetadata") if isinstance(event_payload.get("credentialMetadata"), dict) else {}
            previous_artifact_id = str(account.get("authArtifactId") or "")
            previous_artifact = find_record(db, "mediaAuthArtifacts", previous_artifact_id) if previous_artifact_id else None
            metadata = preserve_editor_token_expiry(
                metadata,
                previous_artifact.get("credentialMetadata") if isinstance(previous_artifact, dict) else {},
            )
            credential_expires_at = str(metadata.get("credentialExpiresAt") or account.get("credentialExpiresAt") or "")
            patch_record(db, "mediaAccounts", account["id"], {
                "status": "active",
                "credentialStatus": "active",
                "credentialExpiresAt": credential_expires_at,
                "lastVerifiedAt": datetime.now(timezone.utc).isoformat(),
                "nextCredentialCheckAt": next_credential_check_at(str(account.get("platform") or ""), credential_expires_at),
                "consecutiveAuthFailures": 0,
                "lastError": "",
                "updatedAt": now_stamp(),
            })
        elif account and next_status == "failed":
            failures = int(account.get("consecutiveAuthFailures") or 0) + 1
            confirmed_logout = any(marker in auth_error_text for marker in [
                "LOGIN_REQUIRED",
                "NEEDS_REAUTH",
                "AUTH_EXPIRED",
                "TOKEN_EXPIRED",
                "SESSION_EXPIRED",
            ])
            patch_record(db, "mediaAccounts", account["id"], {
                "status": "needs_reauth" if confirmed_logout else "active",
                "credentialStatus": "needs_reauth" if confirmed_logout else "stale",
                "consecutiveAuthFailures": failures,
                "nextCredentialCheckAt": "" if confirmed_logout else credential_retry_at(),
                "lastError": error_message or event_payload.get("errorMessage") or "SESSION_VALIDATION_FAILED",
                "updatedAt": now_stamp(),
            })
    if command.get("type") in {"publish_article", "discover_publication"} and next_status == "failed" and any(marker in auth_error_text for marker in ["LOGIN_REQUIRED", "NEEDS_REAUTH", "AUTH_EXPIRED", "TOKEN_EXPIRED"]):
        account = find_record(db, "mediaAccounts", str(command.get("mediaAccountId") or ""))
        if account:
            patch_record(db, "mediaAccounts", account["id"], {
                "status": "needs_reauth",
                "credentialStatus": "needs_reauth",
                "lastError": error_message or event_payload.get("errorMessage") or "LOGIN_REQUIRED",
                "updatedAt": now_stamp(),
            })
    media_order = None
    index_submission = None
    if command.get("type") == "publish_article":
        command_payload = command.get("payload") if isinstance(command.get("payload"), dict) else {}
        article_id = str(command_payload.get("articleId") or "")
        media_order_id = str(result.get("mediaOrderId") or "")
        current_order = find_record(db, "mediaOrders", media_order_id) if media_order_id else None
        if current_order and event_type == "publish_failed":
            event_platform_status = str(event_payload.get("platformStatus") or "").strip().lower()
            event_url = str(
                event_payload.get("reviewUrl")
                or event_payload.get("publishedUrl")
                or event_payload.get("draftUrl")
                or ""
            ).strip()
            if event_platform_status in ACCEPTED_PUBLICATION_STATUSES:
                media_order = patch_record(db, "mediaOrders", current_order["id"], {
                    "status": "review_required",
                    "backlinkStatus": "reviewing" if event_url else "blocked",
                    "platformStatus": event_platform_status,
                    **({"reviewUrl": event_url} if event_url else {}),
                    "reviewStatus": current_order.get("reviewStatus") or "pending_public_visibility",
                    "errorMessage": str(event_payload.get("message") or "").strip(),
                    "updatedAt": now_stamp(),
                })
                if article_id and find_record(db, "articles", article_id):
                    patch_record(db, "articles", article_id, {
                        "publishStatus": event_platform_status,
                        "publicationStatus": "review_required",
                        "mediaPublishStatus": "review_required",
                        "mediaBacklinkStatus": media_order.get("backlinkStatus") or "blocked",
                        "updatedAt": now_stamp(),
                    })
            else:
                media_order = patch_record(db, "mediaOrders", current_order["id"], {
                    "status": "failed",
                    "backlinkStatus": "failed",
                    "platformStatus": str(event_payload.get("platformStatus") or "failed"),
                    "errorMessage": error_message or str(event_payload.get("errorMessage") or "DESKTOP_COMMAND_FAILED"),
                })
                if article_id and find_record(db, "articles", article_id):
                    patch_record(db, "articles", article_id, {
                        "publishStatus": "failed",
                        "publicationStatus": "failed",
                        "mediaPublishStatus": "failed",
                        "mediaBacklinkStatus": "failed",
                    })
        elif current_order and event_type in {"accepted", "running", "publish_started", "publish_progress", "manual_verification_required"}:
            article_state = "manual_verification_required" if event_type == "manual_verification_required" else "running"
            media_order = patch_record(db, "mediaOrders", current_order["id"], {
                "status": "running",
                "platformStatus": article_state,
                "errorMessage": "",
            })
            if article_id and find_record(db, "articles", article_id):
                patch_record(db, "articles", article_id, {
                    "publishStatus": article_state,
                    "publicationStatus": "running",
                    "mediaPublishStatus": "running",
                })
    if command.get("type") == "discover_publication":
        command_payload = command.get("payload") if isinstance(command.get("payload"), dict) else {}
        order = find_record(db, "mediaOrders", str(command_payload.get("mediaOrderId") or ""))
        if order and next_status == "failed":
            media_order = patch_record(db, "mediaOrders", order["id"], {
                "publicDiscoveryStatus": "failed",
                "status": "review_required",
                "reviewStatus": order.get("reviewStatus") or "pending_public_visibility",
                "errorMessage": publication_discovery_failure_message(error_message),
                "updatedAt": now_stamp(),
            })
        elif order and next_status == "succeeded":
            public_url = str(result.get("publicUrl") or result.get("publishedUrl") or "").strip()
            found = result.get("found") is True and bool(public_url)
            publication_rejected = publication_result_is_rejected(result)
            distribution_restricted = (
                result.get("submissionAccepted") is True
                and str(result.get("platformStatus") or "") == "published_restricted"
                and str(result.get("reviewStatus") or "") == "distribution_restricted"
            )
            if publication_rejected:
                rejected_message = publication_rejected_message(result)
                media_order = patch_record(db, "mediaOrders", order["id"], {
                    "status": "failed",
                    "platformStatus": str(result.get("platformStatus") or "rejected"),
                    "reviewStatus": str(result.get("reviewStatus") or "rejected"),
                    "backlinkStatus": "failed",
                    "backlinkUrl": "",
                    "reviewUrl": "",
                    "publicDiscoveryStatus": "failed",
                    "errorMessage": rejected_message,
                    "updatedAt": now_stamp(),
                })
                article_id = str(command_payload.get("articleId") or order.get("articleId") or "")
                if article_id and find_record(db, "articles", article_id):
                    patch_record(db, "articles", article_id, {
                        "publishStatus": str(result.get("platformStatus") or "rejected"),
                        "publicationStatus": "failed",
                        "mediaPublishStatus": "failed",
                        "mediaBacklinkStatus": "failed",
                        "publishedUrl": "",
                        "mediaPublishedUrl": "",
                        "mediaReviewUrl": "",
                        "mediaPublicDiscoveryStatus": "failed",
                        "mediaOrderId": order["id"],
                        "updatedAt": now_stamp(),
                    })
                result = {
                    **result,
                    "mediaOrderId": order["id"],
                    "publicUrl": "",
                    "publishedUrl": "",
                    "reviewUrl": "",
                    "verified": False,
                    "verificationReason": "PUBLICATION_REJECTED",
                }
            elif distribution_restricted:
                restricted_message = (
                    "网易号已发布，但平台限制内容分发，"
                    "暂时没有可验证公开 URL。请前往网易号内容管理点击申诉。"
                )
                media_order = patch_record(db, "mediaOrders", order["id"], {
                    "status": "succeeded",
                    "platformStatus": "published_restricted",
                    "reviewStatus": "distribution_restricted",
                    "backlinkStatus": "blocked",
                    "backlinkUrl": "",
                    "reviewUrl": "",
                    "publicDiscoveryStatus": "restricted",
                    "errorMessage": restricted_message,
                    "updatedAt": now_stamp(),
                })
                article_id = str(command_payload.get("articleId") or order.get("articleId") or "")
                if article_id and find_record(db, "articles", article_id):
                    patch_record(db, "articles", article_id, {
                        "publishStatus": "published_restricted",
                        "publicationStatus": "published_restricted",
                        "mediaPublishStatus": "published_restricted",
                        "mediaBacklinkStatus": "blocked",
                        "publishedUrl": "",
                        "mediaPublishedUrl": "",
                        "mediaReviewUrl": "",
                        "mediaPublicDiscoveryStatus": "restricted",
                        "mediaOrderId": order["id"],
                        "updatedAt": now_stamp(),
                    })
                result = {
                    **result,
                    "mediaOrderId": order["id"],
                    "verified": False,
                    "verificationReason": "PUBLICATION_DISTRIBUTION_RESTRICTED",
                }
            elif found:
                image_evidence = sanitize_image_publication_evidence(result.get("imagePublicationEvidence"))
                image_evidence = recover_public_only_image_publication_evidence(order, image_evidence)
                expected_image_count = int((order.get("imagePublicationEvidence") or {}).get("expectedCount") or 0)
                if expected_image_count and not image_publication_evidence_matches_order(order, image_evidence):
                    media_order = patch_record(db, "mediaOrders", order["id"], {
                        "reviewUrl": public_url,
                        "publicDiscoveryStatus": "candidate_found",
                        "status": "review_required",
                        "backlinkStatus": "reviewing",
                        "reviewStatus": "pending_public_visibility",
                        "errorMessage": "公开页已找到，但正文图片持久化证据不完整。",
                        "updatedAt": now_stamp(),
                    })
                    result = {
                        **result,
                        "mediaOrderId": order["id"],
                        "verified": False,
                        "verificationReason": "PUBLIC_IMAGE_EVIDENCE_INVALID",
                    }
                    updated_command = patch_record(db, "desktopCommands", command_id, {"result": result, "updatedAt": now_stamp()})
                    return {"command": updated_command, "event": event, "mediaOrder": media_order, "indexSubmission": None}
                patch_record(db, "mediaOrders", order["id"], {
                    "reviewUrl": public_url,
                    "publicDiscoveryStatus": "candidate_found",
                    "reviewStatus": "pending_public_visibility",
                    **({"imagePublicationEvidence": image_evidence} if image_evidence else {}),
                    "updatedAt": now_stamp(),
                })
                verification = verify_media_order_publication(db, {
                    "orderId": order["id"],
                    "url": public_url,
                    "pageText": result.get("pageText") or "",
                    "trustedDesktopEvidence": True,
                    "provider": command_payload.get("provider") or "",
                    "submitIndex": command_payload.get("submitIndex") is True,
                    "checkImmediately": bool(command_payload.get("checkImmediately", True)),
                })
                media_order = verification.get("mediaOrder")
                index_submission = verification.get("indexSubmission")
                if index_submission:
                    index_submission = queue_index_submission(db, {
                        "submissionId": index_submission["id"],
                        "checkImmediately": bool(command_payload.get("checkImmediately", True)),
                    })
                result = {
                    **result,
                    "mediaOrderId": order["id"],
                    "verified": verification.get("verified") is True,
                    "verificationReason": verification.get("reason") or "",
                }
                if index_submission:
                    result["indexSubmissionId"] = index_submission["id"]
            else:
                candidate_url = str(result.get("publicUrl") or result.get("publishedUrl") or "").strip()
                order_platform = str(order.get("platform") or command_payload.get("platform") or "")
                has_public_candidate = candidate_publication_url_is_publishable(
                    order_platform,
                    candidate_url,
                    str(result.get("pageText") or ""),
                )
                has_review_candidate = has_public_candidate or candidate_publication_url_is_publishable(
                    order_platform,
                    candidate_url,
                    "",
                )
                media_order = patch_record(db, "mediaOrders", order["id"], {
                    **({"reviewUrl": candidate_url} if has_review_candidate else {}),
                    "status": "review_required",
                    "backlinkStatus": "reviewing" if has_review_candidate or order.get("reviewUrl") else "blocked",
                    "publicDiscoveryStatus": "candidate_found" if has_review_candidate else "not_found",
                    "reviewStatus": "pending_public_visibility",
                    "errorMessage": str(result.get("message") or (
                        "已找到公开候选地址，但匿名访问尚未通过，等待平台审核或公开延迟。"
                        if has_review_candidate
                        else "内容管理中尚未发现本次文章的公开链接，等待下次重试。"
                    )),
                    "updatedAt": now_stamp(),
                })
                article_id = str(command_payload.get("articleId") or order.get("articleId") or "")
                if article_id and find_record(db, "articles", article_id):
                    patch_record(db, "articles", article_id, {
                        "publicationStatus": "review_required",
                        "mediaPublishStatus": "review_required",
                        "mediaBacklinkStatus": media_order.get("backlinkStatus") or "reviewing",
                        "mediaOrderId": order["id"],
                        "mediaAccountId": media_order.get("mediaAccountId") or "",
                        "mediaPlatform": media_order.get("platform") or order_platform,
                        "mediaReviewUrl": media_order.get("reviewUrl") or "",
                        "mediaPublishedUrl": "",
                        "mediaPublicDiscoveryStatus": media_order.get("publicDiscoveryStatus") or "",
                        "publishStatus": media_order.get("platformStatus") or "submitted_for_review",
                        "indexStatus": "not_submitted",
                        "updatedAt": now_stamp(),
                    })
                result = {
                    **result,
                    "mediaOrderId": order["id"],
                    "verified": False,
                    "verificationReason": "PUBLIC_PAGE_NOT_VISIBLE" if has_public_candidate else "PUBLIC_URL_NOT_DISCOVERED",
                }
            updated_command = patch_record(db, "desktopCommands", command_id, {"result": result, "updatedAt": now_stamp()})
    non_url_platform_statuses = {
        "account_under_review",
        "quota_blocked",
        "daily_publish_quota_zero",
        "needs_reauth",
        "draft_saved",
        "submitted_for_review",
        "pending_public_visibility",
        "reviewing",
        "rejected",
        "review_failed",
        "publish_failed",
    }
    should_create_media_order = command.get("type") == "publish_article" and next_status == "succeeded" and (
        bool(result.get("publishedUrl"))
        or bool(result.get("reviewUrl"))
        or bool(result.get("draftUrl"))
        or str(result.get("platformStatus") or "") in non_url_platform_statuses
    )
    if should_create_media_order:
        account = find_record(db, "mediaAccounts", str(command.get("mediaAccountId") or ""))
        command_payload = command.get("payload") if isinstance(command.get("payload"), dict) else {}
        article_id = str(command_payload.get("articleId") or "")
        article_title = command_payload.get("articleTitle") or command_payload.get("title") or "桌面端发布文章"
        platform_status = str(result.get("platformStatus") or "")
        published_url = str(result.get("publishedUrl") or "").strip()
        order_platform = str(account.get("platform") if account else command_payload.get("platform") or "")
        review_url = str(result.get("reviewUrl") or published_url or "").strip()
        publication_rejected = publication_result_is_rejected(result)
        if published_url and not candidate_publication_url_is_publishable(
            order_platform,
            published_url,
            str(result.get("pageText") or ""),
        ):
            review_url = review_url or published_url
            published_url = ""
        if order_platform == "netease" and is_private_creator_review_url(order_platform, review_url):
            review_url = ""
        candidate_url = str(result.get("candidateUrl") or "").strip()
        if candidate_url and not candidate_publication_url_is_publishable(
            order_platform,
            candidate_url,
            str(result.get("pageText") or ""),
        ):
            candidate_url = ""
        if publication_rejected:
            published_url = ""
            review_url = ""
            candidate_url = ""
            platform_status = platform_status or "rejected"
        result = {
            **result,
            "publishedUrl": published_url,
            "reviewUrl": review_url,
            "candidateUrl": candidate_url,
        }
        inline_images = command_payload.get("inlineImages") if isinstance(command_payload.get("inlineImages"), list) else []
        image_blocks = [
            (position, block)
            for position, block in enumerate(command_payload.get("contentBlocks") or [])
            if isinstance(block, dict) and block.get("type") == "image"
        ]
        expected_image_count = len(image_blocks) or len(inline_images)
        image_evidence = sanitize_image_publication_evidence(result.get("imagePublicationEvidence"))
        public_image_evidence = image_evidence.get("public") if isinstance(image_evidence.get("public"), dict) else {}
        expected_image_identities = [
            (
                str(block.get("assetId") or ""),
                str(block.get("sectionId") or ""),
                position,
            )
            for position, block in image_blocks
        ] or [
            (
                str(image.get("assetId") or ""),
                str(image.get("sectionId") or ""),
                position,
            )
            for position, image in enumerate(inline_images)
            if isinstance(image, dict)
        ]

        def stage_image_identities(stage: Any) -> list[tuple[str, str, int]]:
            if not isinstance(stage, dict):
                return []
            return [
                (
                    str(image.get("assetId") or ""),
                    str(image.get("sectionId") or ""),
                    int(image.get("position") if image.get("position") is not None else -1),
                )
                for image in stage.get("images") or []
                if isinstance(image, dict)
            ]

        upload_draft_image_identities_verified = all(
            stage_image_identities(image_evidence.get(stage_name)) == expected_image_identities
            for stage_name in ["upload", "draft"]
        ) if expected_image_identities else True
        public_image_identities_verified = (
            public_image_evidence.get("status") == "unverifiable"
            or (
                stage_image_identities(image_evidence.get("public")) == expected_image_identities
                if expected_image_identities else True
            )
        )
        image_identities_verified = upload_draft_image_identities_verified and public_image_identities_verified
        image_publication_verified = (
            expected_image_count == 0
            or (
                str(image_evidence.get("status") or "") in {"verified", "review_required"}
                and not blocking_image_evidence_issues(image_evidence)
                and int(image_evidence.get("expectedCount") or 0) >= expected_image_count
                and (
                    public_image_evidence.get("status") == "unverifiable"
                    or (
                        public_image_evidence.get("status") == "verified"
                        and int(public_image_evidence.get("verifiedCount") or 0) >= expected_image_count
                    )
                )
                and image_identities_verified
            )
        )
        image_publication_blocks_publication = (
            expected_image_count > 0
            and (
                not upload_draft_image_identities_verified
                or not image_publication_verified
            )
        )
        is_public_publish = (
            bool(published_url)
            and candidate_publication_url_is_publishable(
                order_platform,
                published_url,
                str(result.get("pageText") or ""),
            )
            and platform_status == "published"
            and result.get("publiclyVisible") is not False
            and not image_publication_blocks_publication
            and not publication_rejected
        )
        order_status = "failed" if publication_rejected else ("succeeded" if is_public_publish else "review_required")
        backlink_status = "failed" if publication_rejected else ("published" if is_public_publish else ("reviewing" if review_url else "blocked"))
        public_image_blocker = image_publication_evidence_public_blocker(image_evidence)
        default_review_message = (
            "\u5e73\u53f0\u5df2\u53d1\u5e03\u6587\u7ae0\uff0c\u4f46\u516c\u5f00\u9875\u88ab\u5e73\u53f0\u906e\u6321\uff08\u767b\u5f55\u5899\u6216\u9a8c\u8bc1\u7801\uff09\uff0c\u6682\u65f6\u65e0\u6cd5\u6838\u9a8c\u6b63\u6587\u56fe\u7247\uff0c\u7b49\u5f85\u4e0b\u6b21\u590d\u9a8c\u3002"
            if expected_image_count and public_image_blocker
            else "\u5e73\u53f0\u5df2\u53d1\u5e03\u6587\u7ae0\uff0c\u4f46\u6b63\u6587\u56fe\u7247\u5c1a\u672a\u901a\u8fc7\u516c\u5f00\u9875\u6301\u4e45\u5316\u9a8c\u8bc1\u3002"
            if expected_image_count and not image_publication_verified
            else "\u5e73\u53f0\u5df2\u63a5\u6536\u53d1\u5e03\u8bf7\u6c42\uff0c\u4f46\u516c\u5f00 URL \u5c1a\u672a\u9a8c\u8bc1\u901a\u8fc7\uff0c\u7b49\u5f85\u5e73\u53f0\u5ba1\u6838\u6216\u516c\u5f00\u5ef6\u8fdf\u3002"
        )
        review_message = publication_rejected_message(result) if publication_rejected else str(result.get("message") or default_review_message)
        media_order = create_media_order(db, {
            "id": current_order["id"] if current_order else f"media-order-{command_id.removeprefix('desktop-command-')}",
            "articleId": article_id,
            "articleTitle": article_title,
            "resourceId": f"account:{account['id']}" if account else "resource-custom",
            "resourceName": account.get("name") if account else "免费媒体账号",
            "mediaAccountId": account.get("id") if account else "",
            "platform": account.get("platform") if account else command_payload.get("platform") or "",
            "status": order_status,
            "backlinkStatus": backlink_status,
            "backlinkUrl": published_url if is_public_publish else "",
            "reviewUrl": published_url if is_public_publish else ("" if publication_rejected else review_url),
            "platformStatus": platform_status,
            "reviewStatus": result.get("reviewStatus") or ("public" if is_public_publish else ("rejected" if publication_rejected else "")),
            "publicDiscoveryStatus": "failed" if publication_rejected else ("" if is_public_publish else (
                "pending" if publication_discovery_required(
                    order_platform,
                    review_url,
                    "pending",
                ) else ""
            )),
            "imagePublicationEvidence": image_evidence,
            "errorMessage": "" if is_public_publish else review_message,
            "sourceCommandId": command_id,
            "attempt": current_order.get("attempt") if current_order else command_payload.get("attempt", 1),
            "createdAt": current_order.get("createdAt") if current_order else now_stamp(),
        })
        if is_public_publish and command_payload.get("submitIndex") is True:
            index_submission = queue_index_submission(db, {
                "id": f"index-submission-{command_id.removeprefix('desktop-command-')}",
                "articleId": article_id,
                "articleTitle": article_title,
                "provider": command_payload.get("provider") or "IndexNow",
                "source": "desktop-command",
                "sourceType": "media",
                "sourceId": media_order["id"],
                "url": result.get("publishedUrl") or "",
                "checkImmediately": bool(command_payload.get("checkImmediately")),
            })
        if article_id and find_record(db, "articles", article_id):
            article_media_patch = {
                "publicationStatus": order_status,
                "mediaPublishStatus": order_status,
                "mediaBacklinkStatus": backlink_status,
                "mediaOrderId": media_order["id"],
                "mediaAccountId": media_order.get("mediaAccountId") or "",
                "mediaPlatform": media_order.get("platform") or "",
                "mediaReviewUrl": media_order.get("reviewUrl") or "",
                "mediaPublishedUrl": media_order.get("backlinkUrl") or "",
                "mediaPublicDiscoveryStatus": media_order.get("publicDiscoveryStatus") or "",
                "indexStatus": "not_submitted",
                "updatedAt": now_stamp(),
            }
            if is_public_publish:
                patch_record(db, "articles", article_id, {
                    **article_media_patch,
                    "status": "published",
                    "publishedUrl": result.get("publishedUrl") or "",
                    "publishStatus": "published",
                })
            else:
                patch_record(db, "articles", article_id, {
                    **article_media_patch,
                    "publishStatus": platform_status or "submitted_for_review",
                })
        command_result = {**result, "mediaOrderId": media_order["id"]}
        if index_submission:
            command_result["indexSubmissionId"] = index_submission["id"]
        updated_command = patch_record(db, "desktopCommands", command_id, {"result": command_result, "updatedAt": now_stamp()})
    command_payload = command.get("payload") if isinstance(command.get("payload"), dict) else {}
    auto_publish_task_id = str(command_payload.get("autoPublishTaskId") or "")
    if auto_publish_task_id:
        sync_auto_publish_task_status(db, auto_publish_task_id)
    audit_event(db, "desktop_command.event", "desktopCommands", command_id, {"type": event_type, "status": next_status})
    return {"command": updated_command, "event": event, "mediaOrder": media_order, "indexSubmission": index_submission}


def delete_by_id(db: Session, kind: str, record_id: str) -> dict:
    from .service import delete_record

    return {"deleted": delete_record(db, kind, record_id)}


def summary_count(items: list[dict], field: str, value: Any) -> int:
    return sum(1 for item in items if item.get(field) == value)


def index_workflow_status(submission: dict | None) -> str:
    if not submission:
        return "not_submitted"
    if submission.get("submitted") is True:
        return "submitted"
    status = str(submission.get("status") or "pending")
    if status in {"pending", "submitting", "provider_pending", "rejected", "failed", "unverified"}:
        return status
    return "pending"


def record_article_exists(article_by_id: dict[str, dict], record: dict) -> bool:
    article_id = str(record.get("articleId") or "").strip()
    return bool(article_id and article_id in article_by_id)


def same_article(record: dict, article: dict) -> bool:
    return str(record.get("articleId") or "").strip() == str(article.get("id") or "").strip()


def same_publication_source(submission: dict, source_type: str, source_id: str) -> bool:
    return (
        str(submission.get("sourceType") or "").strip() == source_type
        and str(submission.get("sourceId") or "").strip() == source_id
    )


def queue_inclusion_checks(db: Session, payload: dict) -> dict:
    if payload.get("async") is False:
        raise HTTPException(status_code=400, detail="INCLUSION_CHECK_REQUIRES_QUEUE")
    ids = payload.get("submissionIds")
    if isinstance(ids, list):
        tasks = [
            create_task(db, "inclusion-check", f"Inclusion check: {item}", {"submissionId": str(item)}, "index")
            for item in ids
        ]
        return {"queued": True, "tasks": tasks}
    submission_id = str(payload.get("submissionId") or "")
    if not submission_id:
        raise HTTPException(status_code=400, detail="SUBMISSION_ID_REQUIRED")
    task = create_task(db, "inclusion-check", f"Inclusion check: {submission_id}", {"submissionId": submission_id}, "index")
    return {"queued": True, "task": task}


def queue_publish_and_index(db: Session, payload: dict) -> dict:
    if payload.get("async") is False:
        raise HTTPException(status_code=400, detail="PUBLISH_AND_INDEX_REQUIRES_QUEUE")
    article_id = str(payload.get("articleId") or "")
    article = get_record(db, "articles", article_id)
    assert_article_editable(article, action="publish")
    site = get_record(db, "sites", str(payload.get("siteId") or ""))
    article = claim_article_publish(db, article_id)
    task = create_task(db, "publish-and-index", f"Publish article: {article.get('title')}", {
        "articleId": article["id"],
        "siteId": site["id"],
        "submitIndex": False,
        "checkImmediately": bool(payload.get("checkImmediately")),
    }, "publish")
    return {"queued": True, "task": task}


def queue_media_backlink_index(db: Session, payload: dict) -> dict:
    if payload.get("async") is False:
        raise HTTPException(status_code=400, detail="MEDIA_BACKLINK_REQUIRES_QUEUE")
    order = get_record(db, "mediaOrders", str(payload.get("orderId") or ""))
    task = create_task(db, "media-backlink-index", f"Media backlink publish: {order.get('articleTitle')}", {
        "orderId": order["id"],
        "submitIndex": False,
        "checkImmediately": bool(payload.get("checkImmediately")),
    }, "media")
    return {"queued": True, "task": task}


def queue_media_publication_recheck(db: Session, payload: dict) -> dict:
    order = get_record(db, "mediaOrders", str(payload.get("orderId") or payload.get("id") or ""))
    candidate_url = str(
        payload.get("url")
        or payload.get("publicUrl")
        or payload.get("reviewUrl")
        or order.get("reviewUrl")
        or order.get("backlinkUrl")
        or ""
    ).strip()
    account_id = media_order_account_id(order)
    account = find_record(db, "mediaAccounts", account_id) if account_id else None
    platform = str(order.get("platform") or account and account.get("platform") or "")
    discovery_status = str(order.get("publicDiscoveryStatus") or "")
    image_evidence = order.get("imagePublicationEvidence") if isinstance(order.get("imagePublicationEvidence"), dict) else {}
    needs_desktop_image_recheck = (
        platform in PUBLICATION_DISCOVERY_PLATFORMS
        and bool(candidate_url)
        and int(image_evidence.get("expectedCount") or 0) > 0
    )
    # A record that failed without a callback URL carries no URL of its own: the operator
    # supplies the published URL they can see on the platform. Route that through the desktop
    # browser when the platform blocks a plain server-side fetch, otherwise the recheck would
    # only ever report an unreachable public page.
    needs_desktop_url_recheck = (
        platform in BROWSER_VERIFIED_PUBLICATION_PLATFORMS
        and bool(candidate_url)
    )
    if needs_desktop_image_recheck or needs_desktop_url_recheck:
        return queue_media_publication_discovery(db, {
            **payload,
            "orderId": order["id"],
            "publicUrl": candidate_url,
        })
    if publication_discovery_required(
        platform,
        candidate_url,
        discovery_status,
        force=payload.get("forceDiscovery") is True,
    ):
        return queue_media_publication_discovery(db, {**payload, "orderId": order["id"]})
    if payload.get("async") is False:
        result = verify_media_order_publication(db, {**payload, "orderId": order["id"], "submitIndex": False})
        submission = result.get("indexSubmission")
        if submission:
            result["indexSubmission"] = queue_index_submission(db, {
                "submissionId": submission["id"],
                "checkImmediately": bool(payload.get("checkImmediately", True)),
            })
        return result
    task = create_task(db, "media-publication-recheck", f"Recheck media publication: {order.get('articleTitle')}", {
        "orderId": order["id"],
        "url": payload.get("url") or payload.get("publicUrl") or payload.get("reviewUrl") or "",
        "submitIndex": False,
        "checkImmediately": bool(payload.get("checkImmediately", True)),
    }, "media")
    return {"queued": True, "task": task}


def published_records(db: Session) -> list[dict]:
    articles = list_records(db, "articles")
    article_by_id = {str(article.get("id")): article for article in articles if article.get("id")}
    jobs = list_records(db, "publishJobs")
    orders = list_records(db, "mediaOrders")
    submissions = list_records(db, "indexSubmissions")

    def publication_submission(article_id: str, source_type: str, source_id: str, url: str | None) -> dict | None:
        url_value = str(url or "").strip()
        linked = [
            item for item in submissions
            if str(item.get("articleId") or "").strip() == article_id
            or same_publication_source(item, source_type, source_id)
        ]
        if url_value:
            found = next((item for item in reversed(linked) if item.get("url") == url_value), None)
            if found:
                return found
        return next((item for item in reversed(linked)), None)

    records: list[dict] = []
    for job in jobs:
        if not record_article_exists(article_by_id, job):
            continue
        published_url = str(job.get("publishedUrl") or "").strip()
        status = str(job.get("status") or "pending")
        if not published_url and status not in {"failed"}:
            continue
        submission = publication_submission(str(job.get("articleId") or ""), "site", job["id"], published_url)
        records.append({
            "id": f"site:{job['id']}",
            "sourceType": "site",
            "sourceId": job["id"],
            "articleId": job.get("articleId", ""),
            "articleTitle": job.get("articleTitle", ""),
            "channelName": job.get("siteName", ""),
            "channelType": job.get("connectorType", ""),
            "status": status,
            "publishedUrl": published_url,
            "indexStatus": index_workflow_status(submission),
            "indexProvider": submission.get("provider") if submission else None,
            "indexSubmissionId": submission.get("id") if submission else None,
            "inclusionStatus": submission.get("inclusionStatus") if submission else "unchecked",
            "checkedAt": submission.get("checkedAt") if submission else "",
            "errorMessage": job.get("errorMessage", ""),
            "updatedAt": job.get("updatedAt", ""),
        })
    for order in orders:
        if not record_article_exists(article_by_id, order):
            continue
        backlink_url = str(order.get("backlinkUrl") or "").strip()
        submission = publication_submission(str(order.get("articleId") or ""), "media", order["id"], backlink_url)
        records.append({
            "id": f"media:{order['id']}",
            "sourceType": "media",
            "sourceId": order["id"],
            "articleId": order.get("articleId", ""),
            "articleTitle": order.get("articleTitle", ""),
            "channelName": order.get("resourceName", ""),
            "channelType": "免费媒体" if str(order.get("resourceId", "")).startswith("account:") else "软文媒体",
            "mediaAccountId": media_order_account_id(order),
            "platform": order.get("platform", ""),
            "status": order.get("status", "pending"),
            "backlinkStatus": order.get("backlinkStatus", "pending"),
            "publishedUrl": backlink_url,
            "reviewUrl": order.get("reviewUrl", ""),
            "indexStatus": index_workflow_status(submission),
            "indexProvider": submission.get("provider") if submission else None,
            "indexSubmissionId": submission.get("id") if submission else None,
            "inclusionStatus": submission.get("inclusionStatus") if submission else "unchecked",
            "checkedAt": submission.get("checkedAt") if submission else "",
            "platformStatus": order.get("platformStatus", ""),
            "attempt": int(order.get("attempt") or 1),
            "reviewStatus": order.get("reviewStatus", ""),
            "publicDiscoveryStatus": order.get("publicDiscoveryStatus", ""),
            "errorMessage": order.get("errorMessage", ""),
            "updatedAt": order.get("updatedAt", ""),
        })
    def publication_record_rank(item: tuple[int, dict]) -> tuple[int, int, str, int]:
        index, record = item
        article = article_by_id.get(str(record.get("articleId") or ""), {})
        source_id = str(record.get("sourceId") or "")
        is_current_source = (
            record.get("sourceType") == "media" and str(article.get("mediaOrderId") or "") == source_id
        ) or (
            record.get("sourceType") == "site" and str(article.get("publishJobId") or "") == source_id
        )
        return (
            1 if is_current_source else 0,
            int(record.get("attempt") or 0),
            sortable_timestamp(record.get("updatedAt") or record.get("createdAt")),
            index,
        )

    sorted_records = [
        record
        for _, record in sorted(enumerate(records), key=publication_record_rank, reverse=True)
    ]
    current_by_article: dict[str, dict] = {}
    unlinked_records: list[dict] = []
    for record in sorted_records:
        article_id = str(record.get("articleId") or "").strip()
        if not article_id:
            unlinked_records.append(record)
            continue
        current_by_article.setdefault(article_id, record)
    return [*current_by_article.values(), *unlinked_records]


def workflow_index_submissions(db: Session) -> list[dict]:
    """Index submissions that belong to the real article -> publication workflow."""
    articles = list_records(db, "articles")
    article_by_id = {str(article.get("id")): article for article in articles if article.get("id")}
    published = published_records(db)
    submission_ids = {str(record.get("indexSubmissionId") or "") for record in published if record.get("indexSubmissionId")}
    source_keys = {
        (str(record.get("sourceType") or ""), str(record.get("sourceId") or ""))
        for record in published
        if record.get("sourceType") and record.get("sourceId")
    }
    article_urls = {
        (str(record.get("articleId") or ""), str(record.get("publishedUrl") or "").strip())
        for record in published
        if record.get("articleId") and str(record.get("publishedUrl") or "").strip()
    }

    records: list[dict] = []
    for submission in list_records(db, "indexSubmissions"):
        if not record_article_exists(article_by_id, submission):
            continue
        submission_id = str(submission.get("id") or "")
        source_key = (str(submission.get("sourceType") or ""), str(submission.get("sourceId") or ""))
        article_url = (str(submission.get("articleId") or ""), str(submission.get("url") or "").strip())
        if submission_id in submission_ids or source_key in source_keys or article_url in article_urls:
            records.append(submission)
    return sorted(records, key=lambda item: sortable_timestamp(item.get("updatedAt") or item.get("createdAt")), reverse=True)


def article_management_center(db: Session, filters: dict[str, str]) -> dict:
    articles = list_records(db, "articles")
    jobs = list_records(db, "publishJobs")
    orders = list_records(db, "mediaOrders")
    submissions = list_records(db, "indexSubmissions")

    def article_job(article: dict) -> dict | None:
        return next((job for job in reversed(jobs) if same_article(job, article)), None)

    def article_order(article: dict) -> dict | None:
        return next((order for order in reversed(orders) if same_article(order, article)), None)

    def article_submission(article: dict, urls: set[str], publication: dict | None, publication_kind: str) -> dict | None:
        article_id = str(article.get("id") or "")
        source_id = str(publication.get("id") or "") if publication else ""
        source_type = "site" if publication_kind == "site" else "media" if publication_kind == "media" else ""
        linked = [
            item for item in reversed(submissions)
            if str(item.get("articleId") or "").strip() == article_id
            or (source_type and source_id and same_publication_source(item, source_type, source_id))
        ]
        return next((item for item in linked if item.get("url") in urls), None) or next(iter(linked), None)

    records = []
    for article in articles:
        job = article_job(article)
        order = article_order(article)
        publication_candidates = [
            ("site", job) if job else None,
            ("media", order) if order else None,
        ]
        publication_kind, publication = max(
            (candidate for candidate in publication_candidates if candidate),
            key=lambda candidate: str(candidate[1].get("updatedAt") or candidate[1].get("createdAt") or ""),
            default=("", None),
        )
        if publication_kind == "media" and publication:
            if publication.get("status") == "succeeded" and publication.get("backlinkUrl"):
                publish_status = "succeeded"
            elif publication.get("status") == "failed" or publication.get("backlinkStatus") == "failed":
                publish_status = "failed"
            else:
                publish_status = publication.get("status") or "pending"
            published_url = str(publication.get("backlinkUrl") or "")
        elif publication_kind == "site" and publication:
            publish_status = publication.get("status") or "pending"
            published_url = str(publication.get("publishedUrl") or "")
        else:
            article_publish_status = str(article.get("publishStatus") or "")
            publish_status = "succeeded" if article_publish_status == "published" or article.get("status") == "published" else article_publish_status or "not_published"
            published_url = str(article.get("publishedUrl") or "")
        related_urls = {url for url in [published_url, job and job.get("publishedUrl"), order and order.get("backlinkUrl")] if url}
        submission = article_submission(article, related_urls, publication, publication_kind)
        records.append({
            "articleId": article["id"],
            "title": article.get("title", ""),
            "keyword": article.get("keyword", ""),
            "status": article.get("status", "draft"),
            "publishStatus": publish_status,
            "indexStatus": index_workflow_status(submission),
            "indexProvider": submission.get("provider") if submission else None,
            "inclusionStatus": submission.get("inclusionStatus") if submission else "unchecked",
            "publishedUrl": published_url,
            "ruleName": article.get("ruleName", ""),
            "articleType": article.get("articleType", ""),
            "source": article.get("source", ""),
            "tags": clean_strings(article.get("tags")),
            "score": article.get("score"),
            "updatedAt": article.get("updatedAt", ""),
        })

    query = filters.get("query", "").lower()
    for key, field in [("status", "status"), ("publishStatus", "publishStatus"), ("indexStatus", "indexStatus"), ("inclusionStatus", "inclusionStatus"), ("articleType", "articleType"), ("ruleName", "ruleName"), ("source", "source")]:
        value = filters.get(key, "")
        if value and value != "all":
            records = [item for item in records if item.get(field) == value]
    tag = filters.get("tag", "")
    if tag and tag != "all":
        records = [item for item in records if tag in item.get("tags", [])]
    if query:
        records = [item for item in records if query in " ".join(str(value) for value in item.values()).lower()]

    all_records = records
    return {
        "records": records,
        "summary": {
            "total": len(articles),
            "draft": summary_count(articles, "status", "draft"),
            "ready": summary_count(articles, "status", "ready"),
            "published": summary_count(articles, "status", "published"),
            "generating": summary_count(articles, "status", "generating"),
            "indexedSubmitted": sum(1 for item in all_records if item["indexStatus"] == "submitted"),
            "included": sum(1 for item in all_records if item["inclusionStatus"] == "indexed"),
            "notSubmitted": sum(1 for item in all_records if item["indexStatus"] == "not_submitted"),
        },
        "facets": {
            "articleTypes": sorted({item.get("articleType", "") for item in all_records if item.get("articleType")}),
            "ruleNames": sorted({item.get("ruleName", "") for item in all_records if item.get("ruleName")}),
            "sources": sorted({item.get("source", "") for item in all_records if item.get("source")}),
            "tags": sorted({tag for item in all_records for tag in item.get("tags", [])}),
        },
    }


def task_article_ids(task: dict, llm_requests: list[dict]) -> list[str]:
    payload = task.get("payload") if isinstance(task.get("payload"), dict) else {}
    result = task.get("result") if isinstance(task.get("result"), dict) else {}
    candidates: list[Any] = []
    for source in (task, payload, result):
        value = source.get("generatedArticleIds") or source.get("articleIds") or []
        if isinstance(value, list):
            candidates.extend(value)
        if source.get("articleId"):
            candidates.append(source["articleId"])
    candidates.extend(item.get("articleId") for item in llm_requests if item.get("taskId") == task.get("id"))
    return list(dict.fromkeys(str(item) for item in candidates if str(item or "").strip()))


def task_source_type(task: dict) -> str:
    task_type = str(task.get("type") or "")
    payload = task.get("payload") if isinstance(task.get("payload"), dict) else {}
    writer_context = payload.get("writerContext") if isinstance(payload.get("writerContext"), dict) else {}
    if task_type == "auto-publish" or task.get("generatedArticleIds"):
        return "auto_publish"
    if payload.get("serpAnalysisId") or writer_context.get("serpAnalysisId") or writer_context.get("mode") == "serp":
        return "serp"
    if payload.get("ruleId") or payload.get("generationRuleId") or task.get("ruleId"):
        return "rule"
    return "manual_ai"


def creation_history_center(db: Session) -> dict:
    articles = list_records(db, "articles")
    article_records = article_management_center(db, {})["records"]
    article_by_id = {item.get("id"): item for item in articles}
    management_by_id = {item.get("articleId"): item for item in article_records}
    llm_requests = list_records(db, "llmRequests")
    tasks = list_records(db, "tasks") + list_records(db, "autoPublishTasks")
    records = []
    for task in tasks:
        payload = task.get("payload") if isinstance(task.get("payload"), dict) else {}
        writer_context = payload.get("writerContext") if isinstance(payload.get("writerContext"), dict) else {}
        article_ids = task_article_ids(task, llm_requests)
        related_articles = [article_by_id[item_id] for item_id in article_ids if item_id in article_by_id]
        related_records = [management_by_id[item_id] for item_id in article_ids if item_id in management_by_id]
        target_platforms = task.get("targetPlatforms") or payload.get("targetPlatforms") or writer_context.get("publishTargetIds") or []
        if not isinstance(target_platforms, list):
            target_platforms = []
        rule_name = task.get("ruleName") or payload.get("ruleName") or ""
        keyword_source = task.get("keywordSource") or payload.get("keywordSource") or payload.get("keyword") or writer_context.get("mode") or ""
        records.append({
            "id": task["id"],
            "sourceType": task_source_type(task),
            "title": task.get("name") or task.get("title", ""),
            "description": task.get("description") or task.get("title", ""),
            "ruleId": task.get("ruleId") or payload.get("ruleId") or payload.get("generationRuleId") or "",
            "ruleName": rule_name,
            "ruleVersion": task.get("ruleVersion") or "",
            "serpId": payload.get("serpAnalysisId") or writer_context.get("serpAnalysisId") or "",
            "keywordSource": keyword_source,
            "targetPlatforms": [str(item) for item in target_platforms if str(item).strip()],
            "articleCount": len(related_articles),
            "readyCount": summary_count(related_articles, "status", "ready"),
            "publishedCount": summary_count(related_articles, "status", "published"),
            "indexSubmittedCount": summary_count(related_records, "indexStatus", "submitted"),
            "includedCount": summary_count(related_records, "inclusionStatus", "indexed"),
            "failedCount": task.get("failedCount") or (1 if task.get("status") == "failed" else 0),
            "failureReasons": [task.get("errorMessage")] if task.get("errorMessage") else [],
            "articles": related_records,
            "createdAt": task.get("createdAt", ""),
            "updatedAt": task.get("updatedAt", task.get("createdAt", "")),
        })
    return {
        "tasks": records,
        "summary": {
            "totalTasks": len(records),
            "autoPublish": summary_count(records, "sourceType", "auto_publish"),
            "serp": summary_count(records, "sourceType", "serp"),
            "rule": summary_count(records, "sourceType", "rule"),
            "manualAi": summary_count(records, "sourceType", "manual_ai"),
            "totalArticles": len(articles),
            "publishedArticles": summary_count(articles, "status", "published"),
            "indexedArticles": summary_count(article_records, "indexStatus", "submitted"),
            "includedArticles": summary_count(article_records, "inclusionStatus", "indexed"),
            "failedTasks": sum(item["failedCount"] for item in records),
        },
        "facets": {
            "sourceTypes": sorted({item["sourceType"] for item in records}),
            "ruleNames": sorted({item["ruleName"] for item in records if item["ruleName"]}),
            "targetPlatforms": sorted({platform for item in records for platform in item.get("targetPlatforms", [])}),
        },
    }


def dashboard_task_href(task: dict) -> str:
    task_type = str(task.get("type") or "")
    if task_type == "auto-publish":
        return "/auto-publish"
    if task_type in {"knowledge-fetch-url", "knowledge-upload-parse", "knowledge-refresh"}:
        return "/ai-writer/knowledge"
    return "/articles/history"


DASHBOARD_HIDDEN_TASK_TYPES = {
    "inclusion-check",
    "index-submit",
    "publish-and-index",
    "media-backlink-index",
    "media-publication-recheck",
    "seo-collection",
}


def dashboard_task_category(task: dict) -> str:
    task_type = str(task.get("type") or "")
    if task_type.startswith("knowledge-"):
        return "knowledge"
    if task_type in {"ai-generate-article", "AI 生成"}:
        return "creation"
    if task_type in {"auto-publish", "publish"}:
        return "publishing"
    return "task"


def dashboard_task_target(task: dict) -> str:
    category = dashboard_task_category(task)
    if category == "knowledge":
        return "knowledge"
    payload = task.get("payload") if isinstance(task.get("payload"), dict) else {}
    for field in ("articleId", "autoPublishTaskId", "knowledgeId", "url", "sourceUrl"):
        value = str(payload.get(field) or "").strip()
        if value:
            return value.lower()
    return str(task.get("title") or task.get("type") or "task").strip().lower()


def dashboard_task_copy(task: dict) -> tuple[str, str]:
    category = dashboard_task_category(task)
    error_message = str(task.get("errorMessage") or "").lower()
    if category == "knowledge":
        if "403" in error_message or "forbidden" in error_message or "browser" in error_message or "scrapling" in error_message:
            return (
                "知识库网页暂未抓取成功",
                "目标网页限制了自动访问，可以在知识库中重新抓取或改用文本、文件导入。",
            )
        return (
            "知识库处理未完成",
            "知识内容暂未处理完成，可以进入知识库重新执行。",
        )
    if category == "creation":
        return (
            "AI 创作任务未完成",
            "文章生成没有完成，可以进入创作历史查看原因并重新生成。",
        )
    if category == "publishing":
        return (
            "自动发布任务未完成",
            "发布任务没有完成，可以进入自动发布页面检查目标账号后重试。",
        )
    return (
        "后台任务未完成",
        "任务没有完成，可以进入任务记录查看并重试。",
    )


def dashboard_failed_task_items(tasks: list[dict]) -> list[dict]:
    grouped: dict[str, dict] = {}
    for task in tasks:
        task_type = str(task.get("type") or "")
        if task.get("status") != "failed" or task_type in DASHBOARD_HIDDEN_TASK_TYPES:
            continue
        category = dashboard_task_category(task)
        key = f"{category}:{dashboard_task_target(task)}"
        title, description = dashboard_task_copy(task)
        candidate = {
            "id": f"task:{task['id']}",
            "type": "task_failed",
            "category": category,
            "title": title,
            "description": description,
            "href": dashboard_task_href(task),
            "severity": "warning",
            "status": task.get("status"),
            "updatedAt": task.get("updatedAt") or task.get("createdAt"),
            "occurrenceCount": 1,
        }
        current = grouped.get(key)
        if current is None:
            grouped[key] = candidate
            continue
        candidate["occurrenceCount"] = int(current.get("occurrenceCount") or 1) + 1
        if str(candidate.get("updatedAt") or "") >= str(current.get("updatedAt") or ""):
            grouped[key] = candidate
        else:
            current["occurrenceCount"] = candidate["occurrenceCount"]
    return list(grouped.values())


def dashboard_work_items(
    articles: list[dict],
    jobs: list[dict],
    submissions: list[dict],
    tasks: list[dict],
    media_orders: list[dict],
    media_accounts: list[dict],
    indexers: list[dict],
) -> list[dict]:
    del articles, submissions, indexers
    items: list[dict] = dashboard_failed_task_items(tasks)

    for job in jobs:
        if job.get("status") == "failed":
            items.append({
                "id": f"publish:{job['id']}",
                "type": "publish_failed",
                "category": "publishing",
                "title": f"发布失败：{job.get('articleTitle')}",
                "description": "发布没有完成，可以进入发布记录查看原因并重新发布。",
                "href": "/published",
                "severity": "critical",
                "status": job.get("status"),
                "updatedAt": job.get("updatedAt") or job.get("createdAt"),
                "occurrenceCount": 1,
            })

    review_groups: dict[str, dict] = {}
    for order in media_orders:
        if order.get("status") == "failed":
            items.append({
                "id": f"media-failed:{order['id']}",
                "type": "publish_failed",
                "category": "publishing",
                "title": f"媒体发布失败：{order.get('articleTitle')}",
                "description": "平台没有完成发布，可以进入发布记录检查账号或重新发布。",
                "href": "/published",
                "severity": "critical",
                "status": order.get("status"),
                "updatedAt": order.get("updatedAt") or order.get("createdAt"),
                "occurrenceCount": 1,
            })
        elif order.get("status") in {"review_required", "submitted_for_review", "account_under_review"}:
            review_key = str(order.get("articleId") or order.get("articleTitle") or order.get("id"))
            current = review_groups.get(review_key)
            if current is None:
                review_groups[review_key] = {
                    "id": f"media-review:{order['id']}",
                    "type": "manual_review",
                    "category": "publishing",
                    "title": f"平台审核中：{order.get('articleTitle')}",
                    "description": order.get("resourceName") or "内容已提交平台，等待平台处理。",
                    "href": "/published",
                    "severity": "info",
                    "status": order.get("status"),
                    "updatedAt": order.get("updatedAt") or order.get("createdAt"),
                    "occurrenceCount": 1,
                }
                continue
            current["occurrenceCount"] = int(current.get("occurrenceCount") or 1) + 1
            current["description"] = f"{current['occurrenceCount']} 个平台正在处理，可在发布记录中查看各平台进度。"
            if str(order.get("updatedAt") or order.get("createdAt") or "") > str(current.get("updatedAt") or ""):
                current["status"] = order.get("status")
                current["updatedAt"] = order.get("updatedAt") or order.get("createdAt")
    items.extend(review_groups.values())
    for account in media_accounts:
        if account.get("status") in {"error", "pending", "needs_reauth"}:
            items.append({
                "id": f"media-auth:{account['id']}",
                "type": "authorization_exception",
                "category": "authorization",
                "title": f"媒体账号需要重新连接：{account.get('name')}",
                "description": "登录状态不可用，重新授权后即可继续自动发布。",
                "href": "/free-media",
                "severity": "critical" if account.get("status") == "error" else "warning",
                "status": account.get("status"),
                "updatedAt": account.get("updatedAt") or account.get("createdAt"),
                "occurrenceCount": 1,
            })

    severity_rank = {"critical": 0, "warning": 1, "info": 2}
    items.sort(key=lambda item: sortable_timestamp(item.get("updatedAt") or item.get("createdAt")), reverse=True)
    items.sort(key=lambda item: severity_rank.get(item["severity"], 2))
    return items[:8]

@app.get("/api/articles")
def get_articles(request: Request, db: Session = Depends(get_db)) -> Any:
    if request.query_params.get("view") == "management":
        return article_management_center(db, dict(request.query_params))
    return list_records(db, "articles")


@app.post("/api/articles")
async def post_articles(request: Request, db: Session = Depends(get_db)) -> dict:
    return create_article(db, await body_json(request))


@app.post("/api/articles/batch-delete")
async def batch_delete_articles(request: Request, db: Session = Depends(get_db)) -> dict:
    payload = await body_json(request)
    article_ids = payload.get("articleIds")
    if not isinstance(article_ids, list):
        raise HTTPException(status_code=400, detail="ARTICLE_IDS_REQUIRED")
    return delete_articles(db, article_ids)


@app.post("/api/articles/generate")
async def generate_article(request: Request, db: Session = Depends(get_db)) -> dict:
    payload = await body_json(request)
    if payload.get("async") is False:
        raise HTTPException(status_code=400, detail="AI_GENERATION_REQUIRES_QUEUE")
    image_strategy = str(payload.get("imageStrategy") or "cover-and-inline")
    if image_strategy not in {"none", "cover", "inline", "cover-and-inline", "thumbnail"}:
        raise HTTPException(status_code=400, detail="INVALID_IMAGE_STRATEGY")
    try:
        max_inline_images = int(payload.get("maxInlineImages", 5))
    except (TypeError, ValueError) as error:
        raise HTTPException(status_code=400, detail="MAX_INLINE_IMAGES_OUT_OF_RANGE") from error
    if max_inline_images < 0 or max_inline_images > 5:
        raise HTTPException(status_code=400, detail="MAX_INLINE_IMAGES_OUT_OF_RANGE")
    payload = {
        **payload,
        "generateImages": payload.get("generateImages", True) is not False,
        "imageStrategy": image_strategy,
        "maxInlineImages": max_inline_images,
    }
    task = create_task(
        db,
        "ai-generate-article",
        f"AI article generation: {payload.get('keyword') or payload.get('title') or 'Untitled'}",
        payload,
        "ai",
    )
    return {"queued": True, "task": task}

@app.post("/api/articles/score")
async def score_article_route(request: Request) -> dict:
    return score_article(await body_json(request))


@app.get("/api/articles/{article_id}")
def get_article(article_id: str, db: Session = Depends(get_db)) -> dict:
    return get_record(db, "articles", article_id)


@app.patch("/api/articles/{article_id}")
async def patch_article(article_id: str, request: Request, db: Session = Depends(get_db)) -> dict:
    payload = await body_json(request)
    article = get_record(db, "articles", article_id)
    # Published articles are frozen: no content/status rewrite from the editor.
    locked_fields = {
        "title", "summary", "contentMarkdown", "seoTitle", "metaDescription", "keywords",
        "sections", "contentBlocks", "coverImage", "inlineImages", "status", "tags",
    }
    if article_is_locked_after_publish(article) and any(key in payload for key in locked_fields):
        assert_article_editable(article, action="edit")
    if any(key in payload for key in ["title", "summary", "contentMarkdown", "keywords", "metaDescription"]):
        payload["score"] = score_article({**article, **payload})
    return patch_record(db, "articles", article_id, payload)


@app.delete("/api/articles/{article_id}")
def delete_article(article_id: str, db: Session = Depends(get_db)) -> dict:
    return delete_articles(db, [article_id])["items"][0]


@app.post("/api/articles/{article_id}/publish-from-context")
async def publish_from_context(article_id: str, request: Request, db: Session = Depends(get_db)) -> dict:
    payload = await body_json(request)
    article = get_record(db, "articles", article_id)
    target_id = str(payload.get("targetId") or "")
    check_immediately = bool(payload.get("checkImmediately"))
    if payload.get("async") is False:
        raise HTTPException(status_code=400, detail="PUBLISH_FROM_CONTEXT_REQUIRES_QUEUE")
    if target_id.startswith("media:"):
        queued = queue_article_media_publish_command(
            db,
            article,
            target_id.replace("media:", ""),
            {**payload, "submitIndex": False, "checkImmediately": check_immediately},
            source="publish-from-context",
        )
        account = queued["account"]
        command = queued["command"]
        return {"queued": True, "channel": "free-media", "targetId": account["id"], "targetName": account.get("name"), "mediaOrder": queued.get("mediaOrder"), "publishJob": None, "indexSubmission": None, "task": None, "desktopCommand": command}
    assert_article_editable(article, action="publish")
    if target_id.startswith("resource:"):
        resource = get_record(db, "mediaResources", target_id.replace("resource:", ""))
        article = claim_article_publish(db, article_id)
        order = create_media_order(db, {"articleId": article_id, "articleTitle": article.get("title"), "resourceId": resource["id"], "resourceName": resource.get("name")})
        task = create_task(db, "media-backlink-index", f"Media backlink publish: {article.get('title') or order['id']}", {
            "orderId": order["id"],
            "submitIndex": False,
            "checkImmediately": check_immediately,
        }, "media")
        return {"queued": True, "channel": "media-market", "targetId": resource["id"], "targetName": resource.get("name"), "mediaOrder": order, "publishJob": None, "indexSubmission": None, "task": task}
    site_id = target_id.replace("site:", "") if target_id.startswith("site:") else target_id
    site = get_record(db, "sites", site_id or (list_records(db, "sites")[0]["id"] if list_records(db, "sites") else ""))
    article = claim_article_publish(db, article_id)
    task = create_task(db, "publish-and-index", f"Publish article: {article.get('title') or article_id}", {
        "articleId": article_id,
        "siteId": site["id"],
        "submitIndex": False,
        "checkImmediately": check_immediately,
    }, "publish")
    return {"queued": True, "channel": "site", "targetId": site["id"], "targetName": site.get("name"), "publishJob": None, "mediaOrder": None, "indexSubmission": None, "task": task}


def register_crud_routes(path: str, kind: str):
    @app.get(path, name=f"list_{kind}")
    def list_route(db: Session = Depends(get_db)) -> list[dict]:
        if kind in {"articleTypes", "generationRules"}:
            ensure_writer_defaults(db)
        return list_records(db, kind)

    @app.post(path, name=f"create_{kind}")
    async def create_route(request: Request, db: Session = Depends(get_db)) -> dict:
        return create_generic(db, kind, await body_json(request))

    @app.patch(f"{path}/{{record_id}}", name=f"patch_{kind}")
    async def patch_route(record_id: str, request: Request, db: Session = Depends(get_db)) -> dict:
        return patch_record(db, kind, record_id, await body_json(request))

    @app.delete(f"{path}/{{record_id}}", name=f"delete_{kind}")
    def delete_route(record_id: str, db: Session = Depends(get_db)) -> dict:
        return delete_by_id(db, kind, record_id)


for route_path, route_kind in [
    ("/api/article-types", "articleTypes"),
    ("/api/brand-library", "brandProfiles"),
    ("/api/competitor-library", "competitorProfiles"),
    ("/api/watermarks", "watermarks"),
    ("/api/generation-rules", "generationRules"),
    ("/api/sites", "sites"),
]:
    register_crud_routes(route_path, route_kind)


@app.post("/api/sites/test-connection")
async def test_site_connection(request: Request, db: Session = Depends(get_db)) -> dict:
    payload = await body_json(request)
    site = get_record(db, "sites", str(payload.get("siteId") or payload.get("id") or ""))
    target = site.get("webhookUrl") or site.get("baseUrl") or ""
    ok = str(target).startswith(("http://", "https://"))
    updated = patch_record(db, "sites", site["id"], {"status": "active" if ok else "test_failed"})
    return {"ok": ok, "site": updated, "message": "连接配置可用" if ok else "URL 格式无效"}


@app.get("/api/assets")
def list_assets(db: Session = Depends(get_db)) -> list[dict]:
    return list_records(db, "assets")


@app.post("/api/assets/upload")
async def upload_asset_file(
    file: UploadFile = File(...),
    altText: str = Form(""),
    tags: str = Form(""),
    relatedArticle: str = Form(""),
    db: Session = Depends(get_db),
) -> dict:
    settings = get_settings()
    upload_dir = Path(settings.upload_dir)
    if not upload_dir.is_absolute():
        upload_dir = Path.cwd() / upload_dir
    asset_dir = upload_dir / "assets"
    asset_dir.mkdir(parents=True, exist_ok=True)
    filename = Path(file.filename or "asset.bin").name
    target = asset_dir / f"{make_id('assets')}-{filename}"
    content = await file.read()
    target.write_bytes(content)
    asset = save_record(db, "assets", {
        "id": make_id("assets"),
        "filename": filename,
        "type": "inline",
        "source": "upload",
        "contentType": file.content_type or "",
        "path": str(target),
        "url": f"/uploads/assets/{target.name}",
        "altText": altText or filename,
        "relatedArticle": relatedArticle,
        "tags": parse_tags(tags),
        "sizeBytes": len(content),
        "size": f"{len(content)} B",
        "createdAt": now_stamp(),
        "updatedAt": now_stamp(),
    })
    audit_event(db, "asset.upload", "assets", asset["id"], {"filename": filename, "sizeBytes": len(content)})
    return asset


@app.post("/api/assets")
async def create_asset(request: Request, db: Session = Depends(get_db)) -> dict:
    return create_generic(db, "assets", await body_json(request))


@app.patch("/api/assets")
async def patch_assets(request: Request, db: Session = Depends(get_db)) -> Any:
    payload = await body_json(request)
    ids = payload.get("ids")
    if isinstance(ids, list):
        tag_names = []
        for tag_id in payload.get("tagIds", []):
            for group in list_records(db, "assetTagGroups"):
                for tag in group.get("tags", []):
                    if tag.get("id") == tag_id:
                        tag_names.append(tag.get("name"))
        updated = []
        for record_id in ids:
            current = get_record(db, "assets", str(record_id))
            tags = sorted(set(clean_strings(current.get("tags")) + tag_names))
            updated.append(patch_record(db, "assets", str(record_id), {"tags": tags}))
        return updated
    return patch_record(db, "assets", str(payload.get("id") or ""), payload)


@app.delete("/api/assets")
async def delete_assets(request: Request, db: Session = Depends(get_db)) -> dict:
    from .service import delete_record

    ids = (await body_json(request)).get("ids") or []
    deleted = 0
    for record_id in ids:
        try:
            delete_record(db, "assets", str(record_id))
            deleted += 1
        except HTTPException:
            pass
    return {"deleted": deleted}


@app.get("/api/assets/tag-groups")
def list_tag_groups(db: Session = Depends(get_db)) -> list[dict]:
    return list_records(db, "assetTagGroups")


@app.post("/api/assets/tag-groups")
async def post_tag_groups(request: Request, db: Session = Depends(get_db)) -> dict:
    payload = await body_json(request)
    if payload.get("groupId") and payload.get("tagName"):
        group = get_record(db, "assetTagGroups", str(payload["groupId"]))
        group["tags"] = group.get("tags", []) + [{"id": make_id("assetTagGroups"), "name": payload["tagName"], "usageCount": 0}]
        return save_record(db, "assetTagGroups", group)
    return create_generic(db, "assetTagGroups", payload)


@app.delete("/api/assets/tag-groups")
async def delete_tag_group_tags(request: Request, db: Session = Depends(get_db)) -> dict:
    payload = await body_json(request)
    tag_ids = set(payload.get("tagIds") or [])
    changed = 0
    for group in list_records(db, "assetTagGroups"):
        next_tags = [tag for tag in group.get("tags", []) if tag.get("id") not in tag_ids]
        if len(next_tags) != len(group.get("tags", [])):
            group["tags"] = next_tags
            save_record(db, "assetTagGroups", group)
            changed += 1
    return {"deleted": changed}


@app.get("/api/knowledge-base")
def list_knowledge(db: Session = Depends(get_db)) -> list[dict]:
    return list_records(db, "knowledgeItems")


@app.post("/api/knowledge-base/upload")
async def upload_knowledge_file(
    file: UploadFile = File(...),
    title: str = Form(""),
    tags: str = Form(""),
    defer: str = Form("true"),
    db: Session = Depends(get_db),
) -> dict:
    should_defer = str(defer).strip().lower() not in {"false", "0", "no", "off"}
    if not should_defer:
        raise HTTPException(status_code=400, detail="KNOWLEDGE_UPLOAD_REQUIRES_QUEUE")
    settings = get_settings()
    upload_dir = Path(settings.upload_dir)
    if not upload_dir.is_absolute():
        upload_dir = Path.cwd() / upload_dir
    upload_dir.mkdir(parents=True, exist_ok=True)
    target = upload_dir / f"{make_id('knowledgeItems')}-{Path(file.filename or 'upload.bin').name}"
    target.write_bytes(await file.read())
    item_id = make_id("knowledgeItems")
    item = {
        "id": item_id,
        "title": title or file.filename or "Uploaded knowledge",
        "source": "upload",
        "filename": file.filename or target.name,
        "contentType": file.content_type or "",
        "path": str(target),
        "tags": parse_tags(tags),
        "refreshMode": "manual",
        "status": "queued",
        "chunkCount": 0,
        "vectorCount": 0,
        "createdAt": now_stamp(),
        "updatedAt": now_stamp(),
    }
    save_record(db, "knowledgeItems", item)
    task = create_task(db, "knowledge-upload-parse", f"Parse knowledge file: {file.filename}", {
        "knowledgeId": item["id"],
        "filename": file.filename,
        "path": str(target),
        "contentType": file.content_type or "",
    }, "knowledge")
    item = patch_record(db, "knowledgeItems", item["id"], {"taskId": task["id"]})
    audit_event(db, "knowledge.upload", "knowledgeItems", item["id"], {"filename": file.filename, "taskId": task["id"]})
    log_task_event(db, task["id"], "knowledge.parse_queued", "Knowledge upload parse queued for worker", detail={"knowledgeId": item["id"], "path": str(target)})
    return item


@app.post("/api/knowledge-base/fetch-url")
async def fetch_knowledge_url(request: Request, db: Session = Depends(get_db)) -> dict:
    payload = await body_json(request)
    if payload.get("defer") is False:
        raise HTTPException(status_code=400, detail="KNOWLEDGE_FETCH_REQUIRES_QUEUE")
    url = str(payload.get("url") or "").strip()
    if not url:
        raise HTTPException(status_code=400, detail="URL_REQUIRED")
    item = {
        "id": make_id("knowledgeItems"),
        "title": payload.get("title") or url,
        "source": "url",
        "url": url,
        "tags": clean_strings(payload.get("tags")),
        "refreshMode": payload.get("refreshMode") or "manual",
        "status": "queued",
        "errorMessage": "",
        "createdAt": now_stamp(),
        "updatedAt": now_stamp(),
    }
    save_record(db, "knowledgeItems", item)
    task = create_task(db, "knowledge-fetch-url", f"Fetch knowledge URL: {url}", {"knowledgeId": item["id"], "url": url, "payload": payload}, "knowledge")
    item = patch_record(db, "knowledgeItems", item["id"], {"taskId": task["id"]})
    audit_event(db, "knowledge.fetch_url", "knowledgeItems", item["id"], {"url": url, "taskId": task["id"]})
    log_task_event(db, task["id"], "knowledge.fetch_queued", "URL fetch queued for worker")
    return item


@app.post("/api/knowledge-base/search")
async def search_knowledge(request: Request, db: Session = Depends(get_db)) -> dict:
    return search_knowledge_chunks(db, await body_json(request))


@app.get("/api/knowledge-base/{knowledge_id}/chunks")
def get_knowledge_chunks(knowledge_id: str, db: Session = Depends(get_db)) -> list[dict]:
    return [item for item in list_records(db, "knowledgeChunks") if item.get("knowledgeId") == knowledge_id]


@app.post("/api/knowledge-base")
async def post_knowledge(request: Request, db: Session = Depends(get_db)) -> dict:
    payload = await body_json(request)
    if payload.get("refreshId"):
        item = get_record(db, "knowledgeItems", str(payload["refreshId"]))
        url = str(item.get("url") or "").strip()
        path = str(item.get("path") or "").strip()
        if url:
            task = create_task(
                db,
                "knowledge-fetch-url",
                f"Refresh knowledge URL: {url}",
                {"knowledgeId": item["id"], "url": url, "payload": {"refresh": True}},
                "knowledge",
            )
            return patch_record(db, "knowledgeItems", item["id"], {
                "status": "queued",
                "errorMessage": "",
                "taskId": task["id"],
                "updatedAt": now_stamp(),
            })
        if path:
            task = create_task(
                db,
                "knowledge-upload-parse",
                f"Refresh knowledge file: {item.get('title') or path}",
                {
                    "knowledgeId": item["id"],
                    "path": path,
                    "contentType": item.get("contentType") or "",
                },
                "knowledge",
            )
            return patch_record(db, "knowledgeItems", item["id"], {
                "status": "queued",
                "errorMessage": "",
                "taskId": task["id"],
                "updatedAt": now_stamp(),
            })
        # text-only: re-chunk existing content
        return patch_record(db, "knowledgeItems", item["id"], {"status": "completed", "updatedAt": now_stamp()})
    return create_generic(db, "knowledgeItems", payload)


@app.get("/api/tasks")
def get_tasks(db: Session = Depends(get_db)) -> list[dict]:
    return list_records(db, "tasks")


@app.post("/api/tasks")
async def post_task(request: Request, db: Session = Depends(get_db)) -> dict:
    payload = await body_json(request)
    task = create_task(
        db,
        str(payload.get("type") or "manual-task"),
        str(payload.get("title") or payload.get("name") or "Manual task"),
        payload.get("payload") if isinstance(payload.get("payload"), dict) else payload,
        str(payload.get("queue") or "default"),
        status=str(payload.get("status")) if payload.get("status") else None,
        error_message=str(payload.get("errorMessage") or ""),
    )
    if payload.get("status") and task.get("status") != payload.get("status"):
        task = patch_record(db, "tasks", task["id"], {"status": payload.get("status"), "errorMessage": payload.get("errorMessage") or ""})
    return task


@app.get("/api/tasks/{task_id}")
def get_task(task_id: str, db: Session = Depends(get_db)) -> dict:
    return get_record(db, "tasks", task_id)


@app.get("/api/tasks/{task_id}/logs")
def get_task_logs(task_id: str, db: Session = Depends(get_db)) -> list[dict]:
    return [item for item in list_records(db, "taskLogs") if item.get("taskId") == task_id]


@app.post("/api/tasks/{task_id}/retry")
def retry_task_route(task_id: str, db: Session = Depends(get_db)) -> dict:
    return retry_task(db, task_id)


@app.get("/api/audit-logs")
def get_audit_logs(db: Session = Depends(get_db)) -> list[dict]:
    return list_records(db, "auditLogs")


@app.get("/api/notifications")
def get_notifications(db: Session = Depends(get_db)) -> list[dict]:
    return list_notifications(db)


@app.post("/api/notifications")
async def create_notification_route(request: Request, db: Session = Depends(get_db)) -> dict:
    return create_notification_from_payload(db, await body_json(request))


@app.patch("/api/notifications/{notification_id}")
async def patch_notification_route(notification_id: str, request: Request, db: Session = Depends(get_db)) -> dict:
    payload = await body_json(request)
    if "read" in payload and set(payload.keys()).issubset({"read"}):
        return mark_notification_read(db, notification_id, bool(payload.get("read")))
    return patch_record(db, "notifications", notification_id, payload)


@app.post("/api/notifications/batch")
async def batch_notifications_route(request: Request, db: Session = Depends(get_db)) -> dict:
    return batch_mark_notifications(db, await body_json(request))


@app.get("/api/failure-center")
def get_failure_center(db: Session = Depends(get_db)) -> dict:
    return failure_center(db)


@app.get("/api/failure-center/{task_id}")
def get_failure_detail(task_id: str, db: Session = Depends(get_db)) -> dict:
    return failure_detail(db, task_id)


@app.post("/api/failure-center/{task_id}/retry")
def retry_failure_center_task(task_id: str, db: Session = Depends(get_db)) -> dict:
    return retry_failed_task(db, task_id)


def collection_record_payload(task_type: str, payload: dict, record_kind: str) -> dict:
    created_at = now_stamp()
    base = {
        **payload,
        "id": payload.get("id") or make_id(record_kind),
        "status": "queued",
        "provider": payload.get("provider") or "unconfigured",
        "createdAt": payload.get("createdAt") or created_at,
        "updatedAt": payload.get("updatedAt") or created_at,
    }
    if task_type == "keyword-discover":
        seed = str(payload.get("seed") or payload.get("keyword") or payload.get("word") or "").strip()
        return {
            **base,
            "word": payload.get("word") or seed,
            "seed": seed,
            "searchVolume": int(payload.get("searchVolume") or 0),
            "difficulty": int(payload.get("difficulty") or 0),
            "trend": payload.get("trend") or "stable",
            "relatedWords": payload.get("relatedWords") if isinstance(payload.get("relatedWords"), list) else [],
        }
    if task_type == "serp-collect":
        keyword = str(payload.get("keyword") or payload.get("seed") or "").strip()
        return {
            **base,
            "keyword": keyword,
            "searchEngine": payload.get("searchEngine") or payload.get("engine") or "Google",
            "region": payload.get("region") or "global",
            "device": payload.get("device") or "desktop",
            "topResults": payload.get("topResults") if isinstance(payload.get("topResults"), list) else [],
            "relatedQuestions": payload.get("relatedQuestions") if isinstance(payload.get("relatedQuestions"), list) else [],
            "relatedKeywords": payload.get("relatedKeywords") if isinstance(payload.get("relatedKeywords"), list) else [],
            "contentBrief": payload.get("contentBrief") or f"等待采集 {keyword} 的 SERP 结果并生成创作 brief。",
            "analyzedAt": payload.get("analyzedAt") or created_at,
        }
    if task_type == "geo-collect":
        keyword = str(payload.get("keyword") or payload.get("brand") or "").strip()
        platform = payload.get("platform") or ((payload.get("platforms") or ["unconfigured"])[0] if isinstance(payload.get("platforms"), list) else "unconfigured")
        return {
            **base,
            "keyword": keyword,
            "question": payload.get("question") or f"{keyword} 在 AI 搜索回答中的引用表现如何？",
            "platform": platform,
            "sourceUrl": payload.get("sourceUrl") or "",
            "sourceMedia": payload.get("sourceMedia") or "",
            "answerExcerpt": payload.get("answerExcerpt") or "",
            "brandMention": bool(payload.get("brandMention", False)),
            "competitorMention": bool(payload.get("competitorMention", False)),
            "queryTime": payload.get("queryTime") or created_at,
        }
    if task_type == "ranking-check":
        return {
            **base,
            "keyword": payload.get("keyword") or "",
            "url": payload.get("url") or "",
            "engine": payload.get("engine") or payload.get("searchEngine") or "Google",
            "region": payload.get("region") or "global",
            "position": int(payload.get("position") or payload.get("rank") or 0),
            "previousPosition": payload.get("previousPosition"),
            "change": int(payload.get("change") or 0),
            "checkedAt": payload.get("checkedAt") or created_at,
        }
    return base


def collection_task(db: Session, task_type: str, title: str, payload: dict, record_kind: str, queue: str = "seo") -> dict:
    if payload.get("async") is False:
        raise HTTPException(status_code=400, detail="SEO_COLLECTION_REQUIRES_QUEUE")
    provider_config_id = str(payload.get("providerConfigId") or "")
    provider_config = get_record(db, "seoProviderConfigs", provider_config_id) if provider_config_id else None
    if provider_config:
        payload = {
            **payload,
            "providerConfigId": provider_config["id"],
            "provider": provider_config.get("provider") or payload.get("provider") or "configured-provider",
            "providerName": provider_config.get("name") or "",
        }
    record = save_record(db, record_kind, collection_record_payload(task_type, payload, record_kind))
    task = create_task(db, task_type, title, {"recordId": record["id"], **payload}, queue)
    audit_event(db, f"{task_type}.queue", record_kind, record["id"], {"taskId": task["id"], "provider": record.get("provider"), "providerConfigId": provider_config_id})
    return {"record": record, "task": task}


@app.get("/api/seo-provider-configs")
def get_seo_provider_configs(db: Session = Depends(get_db)) -> list[dict]:
    return list_seo_provider_configs(db)


@app.post("/api/seo-provider-configs")
async def create_seo_provider_config_route(request: Request, db: Session = Depends(get_db)) -> dict:
    return create_seo_provider_config(db, await body_json(request))


@app.patch("/api/seo-provider-configs/{config_id}")
async def patch_seo_provider_config_route(config_id: str, request: Request, db: Session = Depends(get_db)) -> dict:
    return patch_seo_provider_config(db, config_id, await body_json(request))


@app.post("/api/seo-provider-configs/{config_id}/health-check")
def health_check_seo_provider_config_route(config_id: str, db: Session = Depends(get_db)) -> dict:
    return health_check_seo_provider_config(db, config_id)


@app.post("/api/keywords/discover")
async def discover_keywords(request: Request, db: Session = Depends(get_db)) -> dict:
    payload = await body_json(request)
    return collection_task(db, "keyword-discover", f"Keyword discovery: {payload.get('seed') or payload.get('keyword')}", payload, "keywords")


@app.post("/api/serp-analysis/collect")
async def collect_serp(request: Request, db: Session = Depends(get_db)) -> dict:
    payload = await body_json(request)
    return collection_task(db, "serp-collect", f"SERP collection: {payload.get('keyword')}", payload, "serpAnalyses")


@app.post("/api/geo-analysis/collect")
async def collect_geo(request: Request, db: Session = Depends(get_db)) -> dict:
    payload = await body_json(request)
    return collection_task(db, "geo-collect", f"GEO collection: {payload.get('brand') or payload.get('keyword')}", payload, "geoQuestions")


@app.post("/api/ranking-tracker/check")
async def check_ranking(request: Request, db: Session = Depends(get_db)) -> dict:
    payload = await body_json(request)
    return collection_task(db, "ranking-check", f"Ranking check: {payload.get('keyword')}", payload, "rankingEntries")


@app.get("/api/indexers")
def get_indexers(request: Request, db: Session = Depends(get_db)) -> Any:
    runtime_by_provider = {
        item["provider"]: item
        for item in SearchIndexService().statuses()
    }
    configs = list_records(db, "indexerConfigs")
    existing = {item.get("provider") for item in configs}
    for provider in INDEX_PROVIDERS:
        if provider not in existing:
            configs.append(save_record(db, "indexerConfigs", default_by_kind("indexerConfigs", {"id": f"indexer-{provider.lower()}", "name": f"{provider} Indexer", "provider": provider, "authorized": False, "autoSubmit": False, "triggerEvents": ["manual_submit"], "connectedIntegrationIds": [], "retryLimit": 2})))
    if request.query_params.get("view") == "center":
        submissions = list_records(db, "indexSubmissions")
        integrations = [{"id": item["id"], "name": item.get("name"), "type": "site"} for item in list_records(db, "sites")] + [{"id": item["id"], "name": item.get("name"), "type": "media"} for item in list_canonical_media_accounts(db)]
        config_records = []
        for config in configs:
            provider = config.get("provider")
            runtime = runtime_by_provider.get(provider, {})
            provider_submissions = [item for item in submissions if item.get("provider") == provider]
            config_records.append({
                **config,
                **runtime,
                "authorized": bool(runtime.get("configured")),
                "submittedCount": sum(1 for item in provider_submissions if item.get("submitted") is True),
                "includedCount": summary_count(provider_submissions, "inclusionStatus", "indexed"),
                "retryQueueCount": sum(1 for item in provider_submissions if item.get("inclusionStatus") in ["not_indexed", "failed"]),
            })
        return {"configs": config_records, "integrations": integrations, "summary": {"total": len(config_records), "authorized": summary_count(config_records, "authorized", True), "autoSubmitEnabled": summary_count(config_records, "autoSubmit", True), "retryQueue": sum(item.get("retryQueueCount", 0) for item in config_records), "authorizationErrors": sum(1 for item in config_records if not item.get("configured") or item.get("error"))}}
    return [
        {
            **config,
            **runtime_by_provider.get(config.get("provider"), {}),
            "authorized": bool(runtime_by_provider.get(config.get("provider"), {}).get("configured")),
        }
        for config in configs
    ]


@app.post("/api/indexers")
async def post_indexer(request: Request, db: Session = Depends(get_db)) -> dict:
    payload = await body_json(request)
    secret_fields = {"authKey", "apiKey", "token", "credentials", "serviceAccountJson", "clientSecret"}
    if any(payload.get(field) for field in secret_fields):
        raise HTTPException(status_code=400, detail="INDEX_CREDENTIALS_ENV_ONLY")
    provider = payload.get("provider") or "Google"
    record_id = f"indexer-{str(provider).lower()}"
    current = find_record(db, "indexerConfigs", record_id) or default_by_kind("indexerConfigs", {"id": record_id, "provider": provider, "name": f"{provider} Indexer"})
    editable_fields = {"provider", "name", "autoSubmit", "triggerEvents", "connectedIntegrationIds", "retryLimit"}
    safe_payload = {key: value for key, value in payload.items() if key in editable_fields}
    saved = save_record(db, "indexerConfigs", {**current, **safe_payload, "updatedAt": now_stamp()})
    runtime = next((item for item in SearchIndexService().statuses() if item.get("provider") == provider), {})
    return {**saved, **runtime, "authorized": bool(runtime.get("configured"))}


@app.patch("/api/indexers")
async def patch_indexer(request: Request, db: Session = Depends(get_db)) -> dict:
    payload = await body_json(request)
    secret_fields = {"authKey", "apiKey", "token", "credentials", "serviceAccountJson", "clientSecret"}
    if any(payload.get(field) for field in secret_fields):
        raise HTTPException(status_code=400, detail="INDEX_CREDENTIALS_ENV_ONLY")
    provider = payload.get("provider") or "Google"
    editable_fields = {"name", "autoSubmit", "triggerEvents", "connectedIntegrationIds", "retryLimit"}
    safe_payload = {key: value for key, value in payload.items() if key in editable_fields}
    saved = patch_record(db, "indexerConfigs", f"indexer-{str(provider).lower()}", safe_payload)
    runtime = next((item for item in SearchIndexService().statuses() if item.get("provider") == provider), {})
    return {**saved, **runtime, "authorized": bool(runtime.get("configured"))}


@app.put("/api/indexers")
async def retry_indexer(request: Request, db: Session = Depends(get_db)) -> dict:
    payload = await body_json(request)
    provider = payload.get("provider")
    retryable = [item for item in list_records(db, "indexSubmissions") if (not provider or item.get("provider") == provider) and item.get("inclusionStatus") in ["not_indexed", "failed", "unchecked"]]
    tasks = []
    for item in retryable:
        tasks.append(create_task(db, "inclusion-check", f"Retry inclusion check: {item.get('articleTitle') or item['id']}", {
            "submissionId": item["id"],
            "provider": item.get("provider") or provider or "",
            "source": "indexer-retry",
        }, "index"))
    audit_event(db, "indexer.retry_queue", "indexSubmissions", str(provider or "all"), {"provider": provider, "count": len(tasks), "taskIds": [task["id"] for task in tasks]})
    return {"queued": True, "retried": len(tasks), "tasks": tasks}


@app.get("/api/{resource_name}")
def list_resource(resource_name: str, includeSuperseded: bool = False, view: str = "", db: Session = Depends(get_db)) -> Any:
    mapping = {
        "keywords": "keywords",
        "serp-analysis": "serpAnalyses",
        "ranking-tracker": "rankingEntries",
        "competitors": "competitors",
        "media-accounts": "mediaAccounts",
        "media-resources": "mediaResources",
        "media-orders": "mediaOrders",
        "publish-jobs": "publishJobs",
        "index-submissions": "indexSubmissions",
        "auto-publish": "autoPublishTasks",
        "llm-requests": "llmRequests",
        "seo-provider-results": "seoProviderResults",
        "seo-provider-configs": "seoProviderConfigs",
        "audit-logs": "auditLogs",
        "knowledge-chunks": "knowledgeChunks",
        "knowledge-vectors": "knowledgeVectors",
    }
    if resource_name == "geo-analysis":
        return list_records(db, "geoQuestions")
    if resource_name == "geo-stats":
        return {"totalQuestions": 0, "brandMentionRate": 0, "citationRate": 0, "competitorMentionRate": 0, "platforms": []}
    if resource_name == "auto-geo":
        return {"rules": [], "questions": list_records(db, "geoQuestions"), "stats": {}, "summary": {"total": 0, "recommended": 0, "rewritten": 0}}
    if resource_name == "published-center":
        records = published_records(db)
        return {
            "records": records,
            "summary": {
                "total": len(records),
                "site": summary_count(records, "sourceType", "site"),
                "media": summary_count(records, "sourceType", "media"),
                "succeeded": summary_count(records, "status", "succeeded"),
                "failed": summary_count(records, "status", "failed"),
                "indexedSubmitted": summary_count(records, "indexStatus", "submitted"),
                "included": summary_count(records, "inclusionStatus", "indexed"),
                "unchecked": summary_count(records, "inclusionStatus", "unchecked"),
            },
        }
    if resource_name == "creation-history":
        return creation_history_center(db)
    if resource_name == "index-submissions" and view == "workflow":
        return workflow_index_submissions(db)
    kind = mapping.get(resource_name)
    if not kind:
        raise HTTPException(status_code=404, detail="ROUTE_NOT_FOUND")
    if kind == "mediaAccounts" and not includeSuperseded:
        return list_canonical_media_accounts(db)
    return list_records(db, kind)


@app.post("/api/{resource_name}")
async def post_resource(resource_name: str, request: Request, db: Session = Depends(get_db)) -> Any:
    mapping = {
        "keywords": "keywords",
        "serp-analysis": "serpAnalyses",
        "ranking-tracker": "rankingEntries",
        "competitors": "competitors",
        "media-accounts": "mediaAccounts",
        "media-resources": "mediaResources",
        "auto-publish": "autoPublishTasks",
        "llm-requests": "llmRequests",
        "seo-provider-results": "seoProviderResults",
        "audit-logs": "auditLogs",
        "knowledge-chunks": "knowledgeChunks",
        "knowledge-vectors": "knowledgeVectors",
    }
    payload = await body_json(request)
    if resource_name == "batch-operations":
        return await batch_operations(request, db)
    if resource_name == "publish-and-index":
        return queue_publish_and_index(db, payload)
    if resource_name == "media-orders":
        return create_media_order(db, payload)
    if resource_name == "index-submissions":
        return queue_index_submission(db, payload)
    if resource_name == "publish-jobs":
        return create_publish_job(db, get_record(db, "articles", str(payload.get("articleId") or "")), get_record(db, "sites", str(payload.get("siteId") or "")))
    if resource_name == "inclusion-checks":
        return queue_inclusion_checks(db, payload)
    kind = mapping.get(resource_name)
    if not kind:
        raise HTTPException(status_code=404, detail="ROUTE_NOT_FOUND")
    if kind == "autoPublishTasks":
        selected_keywords = clean_strings(payload.get("selectedKeywords") or payload.get("keywords") or [])
        requested_article_ids = clean_strings(payload.get("articleIds") or ([payload.get("articleId")] if payload.get("articleId") else []))
        article_ids = []
        for article_id in requested_article_ids:
            article = get_record(db, "articles", article_id)
            if article["id"] not in article_ids:
                article_ids.append(article["id"])
        if not selected_keywords and not article_ids:
            raise HTTPException(status_code=400, detail="AUTO_PUBLISH_INPUT_REQUIRED")

        schedule_mode = str(payload.get("scheduleMode") or "manual")
        media_account_ids = []
        media_account_names = []
        for account_id in clean_strings(payload.get("mediaAccountIds") or []):
            account = resolve_media_account(db, account_id)
            if not media_account_is_authorized(db, account):
                raise HTTPException(status_code=400, detail="MEDIA_ACCOUNT_NOT_AUTHORIZED")
            if account["id"] not in media_account_ids:
                media_account_ids.append(account["id"])
                media_account_names.append(account.get("accountName") or account.get("name") or account.get("platform") or account["id"])
        if schedule_mode != "manual" and not media_account_ids:
            raise HTTPException(status_code=400, detail="AUTO_PUBLISH_MEDIA_ACCOUNT_REQUIRED")

        run_async = payload.get("async") is not False
        if not run_async:
            raise HTTPException(status_code=400, detail="AUTO_PUBLISH_REQUIRES_QUEUE")
        payload = {
            **payload,
            "selectedKeywords": selected_keywords,
            "articleIds": article_ids,
            "mediaAccountIds": media_account_ids,
            "targetPlatforms": payload.get("targetPlatforms") or media_account_names,
            "scheduleMode": schedule_mode,
        }
        auto_publish_task = default_by_kind(kind, {
            **payload,
            "publishCount": len(selected_keywords) + len(article_ids),
            "successCount": 0,
            "failedCount": 0,
            "generatedArticleIds": [],
            "status": "queued",
        })
        saved_auto_publish_task = save_record(db, kind, auto_publish_task)
        task = create_task(db, "auto-publish", f"Auto publish batch: {saved_auto_publish_task.get('name')}", {
            **payload,
            "autoPublishTaskId": saved_auto_publish_task["id"],
        }, "publish")
        saved_auto_publish_task = patch_record(db, kind, saved_auto_publish_task["id"], {
            "taskId": task["id"],
            "status": task["status"],
        })
        return {"queued": True, "autoPublishTask": saved_auto_publish_task, "task": task}
    return create_generic(db, kind, payload)


@app.patch("/api/media-accounts/{record_id}")
async def patch_media_account(record_id: str, request: Request, db: Session = Depends(get_db)) -> dict:
    return patch_record(db, "mediaAccounts", record_id, await body_json(request))


@app.get("/api/media-accounts/{record_id}")
def get_media_account(record_id: str, db: Session = Depends(get_db)) -> dict:
    return get_record(db, "mediaAccounts", record_id)


@app.post("/api/media-accounts/{record_id}/validate-session")
def validate_media_account_session(record_id: str, db: Session = Depends(get_db)) -> dict:
    return queue_media_account_session_validation(db, record_id)


@app.delete("/api/media-accounts/{record_id}")
def delete_media_account(record_id: str, db: Session = Depends(get_db)) -> dict:
    return delete_by_id(db, "mediaAccounts", record_id)


@app.post("/api/media-orders")
async def post_media_order(request: Request, db: Session = Depends(get_db)) -> dict:
    return create_media_order(db, await body_json(request))


@app.patch("/api/media-orders")
async def patch_media_order(request: Request, db: Session = Depends(get_db)) -> dict:
    payload = await body_json(request)
    return patch_record(db, "mediaOrders", str(payload.get("orderId") or payload.get("id") or ""), payload)


@app.post("/api/media-orders/publish-and-index")
async def media_order_publish_and_index(request: Request, db: Session = Depends(get_db)) -> dict:
    payload = await body_json(request)
    return queue_media_backlink_index(db, payload)


@app.post("/api/media-orders/recheck-publication")
async def media_order_recheck_publication(request: Request, db: Session = Depends(get_db)) -> dict:
    payload = await body_json(request)
    return queue_media_publication_recheck(db, payload)


@app.post("/api/publish-jobs")
async def post_publish_job(request: Request, db: Session = Depends(get_db)) -> dict:
    payload = await body_json(request)
    return create_publish_job(db, get_record(db, "articles", str(payload.get("articleId") or "")), get_record(db, "sites", str(payload.get("siteId") or "")))


@app.post("/api/index-submissions")
async def post_index_submission(request: Request, db: Session = Depends(get_db)) -> dict:
    return queue_index_submission(db, await body_json(request))


@app.get("/api/index-submissions/{submission_id}")
def index_submission_detail(submission_id: str, db: Session = Depends(get_db)) -> dict:
    submission = get_record(db, "indexSubmissions", submission_id)
    source_record = next((
        record for record in published_records(db)
        if record.get("indexSubmissionId") == submission_id
        or (submission.get("url") and record.get("publishedUrl") == submission.get("url"))
    ), None)
    status = str(submission.get("status") or "pending")
    status_titles = {
        "pending": "等待 Provider 提交",
        "submitting": "正在调用 Provider",
        "accepted": "Provider 已受理",
        "provider_pending": "Provider 待配置",
        "rejected": "Provider 已拒绝",
        "failed": "Provider 调用失败",
        "unverified": "旧记录待重新验证",
    }
    timeline = [{
        "type": "submitted" if submission.get("submitted") else "submission_queued",
        "title": status_titles.get(status, "索引提交状态"),
        "description": submission.get("providerMessage") or submission.get("url") or submission.get("articleTitle"),
        "at": submission.get("submittedAt") or submission.get("createdAt"),
        "status": "submitted" if submission.get("submitted") else status,
    }]
    if submission.get("checkedAt") or submission.get("inspectionStatus") not in {None, "", "unchecked"}:
        timeline.append({
            "type": "inclusion_checked",
            "title": "搜索引擎收录验证",
            "description": submission.get("inspectionMessage") or submission.get("verificationMethod") or submission.get("inclusionStatus", "unchecked"),
            "at": submission.get("checkedAt"),
            "status": submission.get("inclusionStatus", "unchecked"),
        })
    retryable = status in {"provider_pending", "rejected", "failed", "unverified"} or (status == "pending" and submission.get("queued") is False)
    checkable = bool(submission.get("url")) and status not in {"pending", "submitting"} and submission.get("inclusionStatus") != "checking"
    return {
        "submission": submission,
        "sourceRecord": source_record,
        "timeline": timeline,
        "nextActions": [
            {"action": "retry-submit", "label": "重新提交", "enabled": retryable, "reason": "任务已在队列或 Provider 已受理" if not retryable else ""},
            {"action": "check-inclusion", "label": "验证收录", "enabled": checkable, "reason": "请等待索引提交任务完成" if not checkable else ""},
            {"action": "copy-url", "label": "复制 URL", "enabled": bool(submission.get("url"))},
        ],
    }


@app.post("/api/index-submissions/{submission_id}/retry")
def retry_index_submission(submission_id: str, db: Session = Depends(get_db)) -> dict:
    return queue_index_submission(db, {"submissionId": submission_id})


@app.post("/api/inclusion-checks")
async def post_inclusion_check(request: Request, db: Session = Depends(get_db)) -> Any:
    payload = await body_json(request)
    return queue_inclusion_checks(db, payload)


@app.post("/api/publish-and-index")
async def post_publish_and_index(request: Request, db: Session = Depends(get_db)) -> dict:
    payload = await body_json(request)
    return queue_publish_and_index(db, payload)


@app.get("/api/published-center")
def get_published_center(db: Session = Depends(get_db)) -> dict:
    records = published_records(db)
    return {
        "records": records,
        "summary": {
            "total": len(records),
            "site": summary_count(records, "sourceType", "site"),
            "media": summary_count(records, "sourceType", "media"),
            "succeeded": summary_count(records, "status", "succeeded"),
            "failed": summary_count(records, "status", "failed"),
            "indexedSubmitted": summary_count(records, "indexStatus", "submitted"),
            "included": summary_count(records, "inclusionStatus", "indexed"),
            "unchecked": summary_count(records, "inclusionStatus", "unchecked"),
        },
    }


@app.get("/api/published-center/{record_id:path}")
def get_published_detail(record_id: str, db: Session = Depends(get_db)) -> dict:
    record = next((item for item in published_records(db) if item["id"] == record_id or item["sourceId"] == record_id), None)
    if not record:
        raise HTTPException(status_code=404, detail="PUBLISHED_RECORD_NOT_FOUND")
    submission = find_record(db, "indexSubmissions", record.get("indexSubmissionId") or "") if record.get("indexSubmissionId") else None
    return {
        "record": record,
        "timeline": [
            {"type": "published", "title": "发布记录", "description": record.get("publishedUrl") or record.get("channelName"), "at": record.get("updatedAt"), "status": record.get("status")},
            *([{
                "type": "index_submitted",
                "title": "可见性记录",
                "description": submission.get("url") or submission.get("providerMessage"),
                "at": submission.get("submittedAt") or submission.get("createdAt"),
                "status": "submitted" if submission.get("submitted") else submission.get("status") or "pending",
            }] if submission else []),
        ],
        "nextActions": [
            {"action": "copy-url", "label": "复制 URL", "enabled": bool(record.get("publishedUrl"))},
            {"action": "check-inclusion", "label": "检测可见性", "enabled": bool(record.get("publishedUrl"))},
        ],
    }


@app.post("/api/batch-operations")
async def batch_operations(request: Request, db: Session = Depends(get_db)) -> dict:
    payload = await body_json(request)
    ids = [str(item) for item in payload.get("recordIds") or []]
    action = payload.get("action")
    result = {"action": action, "requested": len(ids), "matched": 0, "submitted": 0, "checked": 0, "retried": 0, "skipped": 0, "errors": [], "indexSubmissions": [], "publishJobs": [], "mediaOrders": [], "tasks": [], "queued": True}
    if action == "submit-index":
        raise HTTPException(status_code=400, detail="INDEX_SUBMISSION_DISABLED")
    records = published_records(db)
    for record_id in ids:
        record = next((item for item in records if item["id"] == record_id or item["sourceId"] == record_id or item.get("articleId") == record_id), None)
        if not record:
            article = find_record(db, "articles", record_id)
            if article and action == "submit-index":
                url = article.get("publishedUrl", "")
                if not url:
                    result["skipped"] += 1
                    result["errors"].append(f"ARTICLE_URL_MISSING:{article['id']}")
                    continue
                submission = queue_index_submission(db, {
                    "articleId": article["id"],
                    "articleTitle": article.get("title"),
                    "provider": payload.get("provider"),
                    "url": url,
                    "source": "batch-operation",
                    "sourceType": "article",
                    "sourceId": article["id"],
                    "checkImmediately": bool(payload.get("checkImmediately")),
                })
                task = get_record(db, "tasks", submission["taskId"])
                result["submitted"] += 1
                result["matched"] += 1
                result["indexSubmissions"].append(submission)
                result["tasks"].append(task)
            else:
                result["skipped"] += 1
            continue
        result["matched"] += 1
        if action == "submit-index":
            url = record.get("publishedUrl")
            if not url:
                result["skipped"] += 1
                result["errors"].append(f"PUBLISHED_URL_MISSING:{record['id']}")
                continue
            submission = queue_index_submission(db, {
                "articleId": record.get("articleId") or "",
                "articleTitle": record["articleTitle"],
                "provider": payload.get("provider"),
                "url": url,
                "source": "batch-operation",
                "sourceType": record.get("sourceType"),
                "sourceId": record.get("sourceId"),
                "checkImmediately": bool(payload.get("checkImmediately")),
            })
            task = get_record(db, "tasks", submission["taskId"])
            result["submitted"] += 1
            result["indexSubmissions"].append(submission)
            result["tasks"].append(task)
        elif action == "check-inclusion" and record.get("indexSubmissionId"):
            task = create_task(db, "inclusion-check", f"Check inclusion: {record['articleTitle']}", {
                "submissionId": record["indexSubmissionId"],
                "source": "batch-operation",
                "sourceType": record.get("sourceType"),
                "sourceId": record.get("sourceId"),
            }, "index")
            result["checked"] += 1
            result["tasks"].append(task)
        elif action == "retry-failed":
            result["retried"] += 1
    audit_event(db, "batch.operation_queue", "tasks", str(action or "unknown"), {"action": action, "requested": len(ids), "taskIds": [task["id"] for task in result["tasks"]]})
    return result


@app.get("/api/creation-history")
def creation_history(request: Request, db: Session = Depends(get_db)) -> dict:
    return creation_history_center(db)


@app.post("/api/auto-publish/{auto_publish_task_id}/retry-publishes")
def retry_auto_publish_commands(auto_publish_task_id: str, db: Session = Depends(get_db)) -> dict:
    return retry_auto_publish_failures(db, auto_publish_task_id)


@app.get("/api/dashboard/metrics")
def dashboard_metrics(db: Session = Depends(get_db)) -> dict:
    articles = list_records(db, "articles")
    article_by_id = {str(article.get("id")): article for article in articles if article.get("id")}
    jobs = [job for job in list_records(db, "publishJobs") if record_article_exists(article_by_id, job)]
    submissions = workflow_index_submissions(db)
    tasks, recent_tasks = dashboard_task_records(db)
    sites = list_records(db, "sites")
    media_orders = [order for order in list_records(db, "mediaOrders") if record_article_exists(article_by_id, order)]
    media_accounts = list_canonical_media_accounts(db)
    runtime_indexers = {item["provider"]: item for item in SearchIndexService().statuses()}
    indexers = [
        {
            **item,
            **runtime_indexers.get(item.get("provider"), {}),
            "authorized": bool(runtime_indexers.get(item.get("provider"), {}).get("configured")),
        }
        for item in list_records(db, "indexerConfigs")
    ]
    work_items = dashboard_work_items(articles, jobs, submissions, tasks, media_orders, media_accounts, indexers)
    published = summary_count(articles, "status", "published")
    succeeded_jobs = summary_count(jobs, "status", "succeeded")
    publication_records = published_records(db)
    recent_publishes = sorted(
        publication_records,
        key=lambda item: sortable_timestamp(item.get("updatedAt") or item.get("createdAt")),
        reverse=True,
    )[:8]
    published_url_count = sum(bool(item.get("publishedUrl")) and item.get("status") == "succeeded" for item in publication_records)
    running_publishes = dashboard_running_publish_count(db)
    submitted_index_count = sum(1 for submission in submissions if submission.get("submitted") is True)
    return {
        "totalArticles": len(articles),
        "drafts": summary_count(articles, "status", "draft"),
        "published": published,
        "publishSuccessRate": round((succeeded_jobs / len(jobs)) * 100) if jobs else 0,
        "indexRecords": len(submissions),
        "submittedIndexes": submitted_index_count,
        "includedUrls": summary_count(submissions, "inclusionStatus", "indexed"),
        "operationCenter": {
            "today": {"generatedArticles": len(articles), "publishedUrls": published_url_count, "indexSubmitted": submitted_index_count, "includedUrls": summary_count(submissions, "inclusionStatus", "indexed")},
            "summary": {
                "failedTasks": sum(item.get("type") in {"task_failed", "publish_failed"} for item in work_items),
                "authorizationExceptions": summary_count(work_items, "type", "authorization_exception"),
                "manualReview": summary_count(work_items, "type", "manual_review"),
                "pendingIndex": summary_count(work_items, "type", "index_pending"),
                "inclusionProblems": summary_count(work_items, "type", "inclusion_failed"),
            },
            "workItems": work_items,
            "shortcuts": [
                {"label": "AI 创作", "description": "进入 10 步式创作", "href": "/ai-writer", "metric": len(articles)},
                {"label": "自动创作发布", "description": "批量规则任务", "href": "/auto-publish", "metric": len(list_records(db, "autoPublishTasks"))},
                {"label": "已发布", "description": "发布记录中心", "href": "/published", "metric": len(jobs)},
            ],
        },
        "recentTasks": recent_tasks,
        "runningPublishes": running_publishes,
        "sites": sites,
        "recentPublishes": recent_publishes,
    }


@app.post("/api/auto-geo/rewrite-batch")
async def auto_geo_rewrite_queued(request: Request, db: Session = Depends(get_db)) -> dict:
    payload = await body_json(request)
    limit = max(1, int(payload.get("limit") or 5))
    target_platforms = [str(item) for item in payload.get("targetPlatforms") or [] if str(item).strip()]
    candidates = [
        question for question in list_records(db, "geoQuestions")
        if not question.get("brandMention")
        and not question.get("rewriteArticleId")
        and (not target_platforms or question.get("platform") in target_platforms)
    ][:limit]
    auto_geo_task = create_generic(db, "autoPublishTasks", {
        "name": "Auto GEO rewrite",
        "type": "auto-geo-rewrite",
        "status": "queued",
        "targetPlatforms": target_platforms,
        "generatedArticleIds": [],
        "successCount": 0,
        "failedCount": 0,
        "ruleId": payload.get("ruleId") or "",
        "ruleName": payload.get("ruleName") or "Auto GEO rewrite",
        "questionIds": [question["id"] for question in candidates],
    })
    task = create_task(db, "auto-geo-rewrite", f"Auto GEO rewrite: {len(candidates)} questions", {
        "autoGeoTaskId": auto_geo_task["id"],
        "questionIds": [question["id"] for question in candidates],
        "targetPlatforms": target_platforms,
        "ruleId": payload.get("ruleId") or "",
        "ruleName": payload.get("ruleName") or "Auto GEO rewrite",
    }, "ai")
    audit_event(db, "auto_geo.rewrite_queue", "autoPublishTasks", auto_geo_task["id"], {"taskId": task["id"], "questionIds": [question["id"] for question in candidates]})
    return {"queued": True, "autoGeoTask": auto_geo_task, "task": {**task, "name": auto_geo_task["name"], "generatedArticleIds": []}, "questions": candidates, "generatedArticles": []}
