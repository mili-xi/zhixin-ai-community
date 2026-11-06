from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import delete
from sqlalchemy.orm import Session

from ..database import Record
from ..models.workflows import DesktopCommand, DesktopDevice, MediaAccountBinding, MediaOrder, TaskAttempt, TaskJob


CRITICAL_WORKFLOW_KINDS = {
    "tasks",
    "mediaOrders",
    "desktopDevices",
    "desktopCommands",
    "mediaAccountBindings",
}


def _text(value: Any) -> str:
    return str(value or "")


def _optional_text(value: Any) -> str | None:
    normalized = _text(value).strip()
    return normalized or None


def _owner_id(data: dict) -> str:
    return _text(data.get("ownerId") or data.get("userId") or data.get("tenantId") or "legacy-internal-owner")


def _timestamp(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value
    raw = _text(value).strip()
    if not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _common(row: Any, data: dict) -> None:
    row.owner_id = _owner_id(data)
    row.status = _text(data.get("status") or "pending")
    row.data = dict(data)
    row.created_at = _timestamp(data.get("createdAt")) or row.created_at
    row.updated_at = _timestamp(data.get("updatedAt")) or datetime.now(timezone.utc)


def _upsert(db: Session, model: type, record_id: str):
    row = db.get(model, record_id)
    if row is None:
        row = model(id=record_id)
        db.add(row)
    return row


# JSON key -> (mirrored column, referenced table) for every foreign key the
# relational mirror writes.
_FOREIGN_KEYS: dict[str, tuple[tuple[str, Any, Any], ...]] = {
    "desktopCommands": (
        ("deviceId", DesktopCommand.device_id, DesktopDevice),
        ("mediaAccountId", DesktopCommand.media_account_id, Record),
    ),
    "mediaOrders": (
        ("articleId", MediaOrder.article_id, Record),
        ("mediaAccountId", MediaOrder.media_account_id, Record),
        ("sourceCommandId", MediaOrder.source_command_id, DesktopCommand),
    ),
    "mediaAccountBindings": (
        ("mediaAccountId", MediaAccountBinding.media_account_id, Record),
        ("deviceId", MediaAccountBinding.device_id, DesktopDevice),
    ),
}


def _reference_is_alive(db: Session, model: type, reference: str) -> bool:
    if db.get(model, reference) is not None:
        return True
    # The target can be a row added in this same transaction, and the session has
    # autoflush off, so a plain lookup cannot see it yet.
    return any(isinstance(pending, model) and pending.id == reference for pending in db.new)


def _drop_dead_references(db: Session, kind: str, row: Any, data: dict) -> None:
    """Null mirrored foreign keys whose target row no longer exists.

    Deleting the target nulls the mirrored column but leaves the id inside the
    record JSON, so the next write re-injected the dead id and failed the commit
    inside save_record's IntegrityError fallback -- which handed back the old
    row, so the caller believed a write that never landed. Ten review orders sat
    frozen for two months on exactly that. Called once every column is set: a
    flush here would move commit-time failures outside save_record's guard.
    """
    for key, column, model in _FOREIGN_KEYS.get(kind, ()):
        reference = _optional_text(data.get(key))
        if not reference or _reference_is_alive(db, model, reference):
            continue
        setattr(row, column.key, None)


def sync_workflow_record(db: Session, kind: str, data: dict) -> None:
    if kind not in CRITICAL_WORKFLOW_KINDS:
        return
    record_id = _text(data.get("id"))
    if not record_id:
        raise ValueError("WORKFLOW_RECORD_ID_REQUIRED")

    if kind == "tasks":
        row = _upsert(db, TaskJob, record_id)
        _common(row, data)
        row.task_type = _text(data.get("type") or "unknown")
        row.queue_name = _text(data.get("queue") or "legacy-internal-owner")
        row.progress = max(int(data.get("progress") or 0), 0)
        row.payload = data.get("payload") if isinstance(data.get("payload"), dict) else {}
        row.error_message = _text(data.get("errorMessage"))
        # TaskAttempt has a real FK and the session disables autoflush.
        db.flush([row])
        attempt_number = max(int(data.get("retryCount") or 0), 0)
        attempt_id = f"{record_id}:{attempt_number}"
        attempt = _upsert(db, TaskAttempt, attempt_id)
        attempt.task_job_id = record_id
        attempt.attempt_number = attempt_number
        attempt.status = row.status
        attempt.error_message = row.error_message
        attempt.data = dict(data)
        attempt.created_at = _timestamp(data.get("createdAt")) or attempt.created_at
        attempt.updated_at = _timestamp(data.get("updatedAt")) or datetime.now(timezone.utc)
        if row.status == "running" and attempt.started_at is None:
            attempt.started_at = attempt.updated_at
        if row.status in {"succeeded", "failed", "cancelled"}:
            attempt.finished_at = attempt.updated_at
        return

    if kind == "desktopDevices":
        row = _upsert(db, DesktopDevice, record_id)
        _common(row, data)
        row.device_name = _text(data.get("deviceName"))
        row.platform = _text(data.get("platform") or "windows")
        row.app_version = _text(data.get("appVersion"))
        row.public_key = _text(data.get("publicKey"))
        row.device_token_hash = _text(data.get("deviceTokenHash"))
        row.last_seen_at = _timestamp(data.get("lastSeenAt"))
        return

    if kind == "desktopCommands":
        row = _upsert(db, DesktopCommand, record_id)
        _common(row, data)
        row.device_id = _optional_text(data.get("deviceId"))
        row.media_account_id = _optional_text(data.get("mediaAccountId"))
        row.command_type = _text(data.get("type") or "unknown")
        row.payload = data.get("payload") if isinstance(data.get("payload"), dict) else {}
        row.result = data.get("result") if isinstance(data.get("result"), dict) else {}
        row.error_message = _text(data.get("errorMessage"))
        _drop_dead_references(db, kind, row, data)
        return

    if kind == "mediaOrders":
        row = _upsert(db, MediaOrder, record_id)
        _common(row, data)
        row.article_id = _optional_text(data.get("articleId"))
        row.media_account_id = _optional_text(data.get("mediaAccountId"))
        row.source_command_id = _optional_text(data.get("sourceCommandId"))
        row.platform = _text(data.get("platform"))
        row.backlink_url = _text(data.get("backlinkUrl"))
        row.review_status = _text(data.get("reviewStatus"))
        row.error_message = _text(data.get("errorMessage"))
        _drop_dead_references(db, kind, row, data)
        return

    row = _upsert(db, MediaAccountBinding, record_id)
    _common(row, data)
    row.media_account_id = _optional_text(data.get("mediaAccountId"))
    row.device_id = _optional_text(data.get("deviceId"))
    row.session_id = _text(data.get("sessionId"))
    row.artifact_id = _optional_text(data.get("artifactId"))
    row.platform = _text(data.get("platform"))
    row.profile_key = _text(data.get("profileKey"))
    _drop_dead_references(db, kind, row, data)


def delete_workflow_record(db: Session, kind: str, record_id: str) -> None:
    model_by_kind = {
        "tasks": TaskJob,
        "mediaOrders": MediaOrder,
        "desktopDevices": DesktopDevice,
        "desktopCommands": DesktopCommand,
        "mediaAccountBindings": MediaAccountBinding,
    }
    model = model_by_kind.get(kind)
    if model is None:
        return
    if kind == "tasks":
        db.execute(delete(TaskAttempt).where(TaskAttempt.task_job_id == record_id))
    row = db.get(model, record_id)
    if row is not None:
        db.delete(row)
