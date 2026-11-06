"""Add relational mirrors for critical workflow records."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from alembic import op
import sqlalchemy as sa

revision = "0002_critical_workflows"
down_revision = "0001_records_baseline"
branch_labels = None
depends_on = None

KINDS = ("tasks", "mediaOrders", "desktopDevices", "desktopCommands", "mediaAccountBindings")


def _common_columns() -> list[sa.Column]:
    return [
        sa.Column("id", sa.String(length=120), primary_key=True),
        sa.Column("owner_id", sa.String(length=120), nullable=False, server_default="default"),
        sa.Column("status", sa.String(length=80), nullable=False, server_default="pending"),
        sa.Column("data", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    ]


def _json(value: Any) -> dict:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _text(value: Any) -> str:
    return str(value or "")


def _optional(value: Any, allowed: set[str] | None = None) -> str | None:
    normalized = _text(value).strip()
    if not normalized or (allowed is not None and normalized not in allowed):
        return None
    return normalized


def _integer(value: Any) -> int:
    try:
        return max(int(value or 0), 0)
    except (TypeError, ValueError):
        return 0


def _timestamp(value: Any, fallback: Any = None) -> datetime:
    if isinstance(value, datetime):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    if isinstance(fallback, datetime):
        return fallback
    return datetime.now(timezone.utc)


def _common(data: dict, row: dict) -> dict:
    created_at = _timestamp(data.get("createdAt"), row.get("created_at"))
    return {
        "id": row["id"],
        "owner_id": _text(data.get("ownerId") or data.get("userId") or data.get("tenantId") or "default"),
        "status": _text(data.get("status") or "pending"),
        "data": data,
        "created_at": created_at,
        "updated_at": _timestamp(data.get("updatedAt"), row.get("updated_at") or created_at),
    }


def _create_tables() -> None:
    op.create_table(
        "task_jobs", *_common_columns(),
        sa.Column("task_type", sa.String(length=120), nullable=False),
        sa.Column("queue_name", sa.String(length=80), nullable=False, server_default="default"),
        sa.Column("progress", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("error_message", sa.Text(), nullable=False, server_default=""),
    )
    op.create_index("ix_task_jobs_owner_id", "task_jobs", ["owner_id"])
    op.create_index("ix_task_jobs_status", "task_jobs", ["status"])
    op.create_index("ix_task_jobs_task_type", "task_jobs", ["task_type"])
    op.create_index("ix_task_jobs_queue_status", "task_jobs", ["queue_name", "status"])

    op.create_table(
        "task_attempts",
        sa.Column("id", sa.String(length=180), primary_key=True),
        sa.Column("task_job_id", sa.String(length=120), sa.ForeignKey("task_jobs.id", ondelete="CASCADE"), nullable=False),
        sa.Column("attempt_number", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("status", sa.String(length=80), nullable=False, server_default="queued"),
        sa.Column("error_message", sa.Text(), nullable=False, server_default=""),
        sa.Column("data", sa.JSON(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("task_job_id", "attempt_number", name="uq_task_attempt_job_number"),
    )
    op.create_index("ix_task_attempts_job_status", "task_attempts", ["task_job_id", "status"])

    op.create_table(
        "desktop_devices", *_common_columns(),
        sa.Column("device_name", sa.String(length=200), nullable=False, server_default=""),
        sa.Column("platform", sa.String(length=80), nullable=False, server_default="windows"),
        sa.Column("app_version", sa.String(length=80), nullable=False, server_default=""),
        sa.Column("public_key", sa.Text(), nullable=False, server_default=""),
        sa.Column("device_token_hash", sa.String(length=160), nullable=False, server_default=""),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_desktop_devices_owner_id", "desktop_devices", ["owner_id"])
    op.create_index("ix_desktop_devices_status", "desktop_devices", ["status"])
    op.create_index("ix_desktop_devices_platform", "desktop_devices", ["platform"])

    op.create_table(
        "desktop_commands", *_common_columns(),
        sa.Column("device_id", sa.String(length=120), sa.ForeignKey("desktop_devices.id", ondelete="SET NULL"), nullable=True),
        sa.Column("media_account_id", sa.String(length=120), sa.ForeignKey("records.id", ondelete="SET NULL"), nullable=True),
        sa.Column("command_type", sa.String(length=120), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("result", sa.JSON(), nullable=False),
        sa.Column("error_message", sa.Text(), nullable=False, server_default=""),
    )
    for name, columns in (
        ("ix_desktop_commands_owner_id", ["owner_id"]),
        ("ix_desktop_commands_status", ["status"]),
        ("ix_desktop_commands_device_id", ["device_id"]),
        ("ix_desktop_commands_media_account_id", ["media_account_id"]),
        ("ix_desktop_commands_command_type", ["command_type"]),
        ("ix_desktop_commands_device_status", ["device_id", "status"]),
    ):
        op.create_index(name, "desktop_commands", columns)

    op.create_table(
        "media_orders", *_common_columns(),
        sa.Column("article_id", sa.String(length=120), sa.ForeignKey("records.id", ondelete="SET NULL"), nullable=True),
        sa.Column("media_account_id", sa.String(length=120), sa.ForeignKey("records.id", ondelete="SET NULL"), nullable=True),
        sa.Column("source_command_id", sa.String(length=120), sa.ForeignKey("desktop_commands.id", ondelete="SET NULL"), nullable=True),
        sa.Column("platform", sa.String(length=80), nullable=False, server_default=""),
        sa.Column("backlink_url", sa.Text(), nullable=False, server_default=""),
        sa.Column("review_status", sa.String(length=100), nullable=False, server_default=""),
        sa.Column("error_message", sa.Text(), nullable=False, server_default=""),
        sa.UniqueConstraint("source_command_id", name="uq_media_orders_source_command"),
    )
    for name, columns in (
        ("ix_media_orders_owner_id", ["owner_id"]),
        ("ix_media_orders_status", ["status"]),
        ("ix_media_orders_article_id", ["article_id"]),
        ("ix_media_orders_media_account_id", ["media_account_id"]),
        ("ix_media_orders_platform", ["platform"]),
        ("ix_media_orders_platform_status", ["platform", "status"]),
    ):
        op.create_index(name, "media_orders", columns)

    op.create_table(
        "media_account_bindings", *_common_columns(),
        sa.Column("media_account_id", sa.String(length=120), sa.ForeignKey("records.id", ondelete="CASCADE"), nullable=True),
        sa.Column("device_id", sa.String(length=120), sa.ForeignKey("desktop_devices.id", ondelete="SET NULL"), nullable=True),
        sa.Column("session_id", sa.String(length=160), nullable=False, server_default=""),
        sa.Column("artifact_id", sa.String(length=160), nullable=True),
        sa.Column("platform", sa.String(length=80), nullable=False, server_default=""),
        sa.Column("profile_key", sa.String(length=200), nullable=False, server_default=""),
        sa.UniqueConstraint("artifact_id", name="uq_media_account_bindings_artifact"),
    )
    for name, columns in (
        ("ix_media_account_bindings_owner_id", ["owner_id"]),
        ("ix_media_account_bindings_status", ["status"]),
        ("ix_media_account_bindings_media_account_id", ["media_account_id"]),
        ("ix_media_account_bindings_device_id", ["device_id"]),
        ("ix_media_account_bindings_session_id", ["session_id"]),
        ("ix_media_account_bindings_platform", ["platform"]),
        ("ix_media_account_bindings_account_status", ["media_account_id", "status"]),
    ):
        op.create_index(name, "media_account_bindings", columns)


def _insert(table: sa.Table, values: dict) -> None:
    op.get_bind().execute(table.insert().values(**values))


def _backfill() -> None:
    bind = op.get_bind()
    rows = list(bind.execute(sa.text(
        "SELECT id, kind, data, created_at, updated_at FROM records "
        "WHERE kind IN ('tasks','mediaOrders','desktopDevices','desktopCommands','mediaAccountBindings')"
    )).mappings())
    if not rows:
        return

    metadata = sa.MetaData()
    metadata.reflect(bind, only=["task_jobs", "task_attempts", "desktop_devices", "desktop_commands", "media_orders", "media_account_bindings"])
    tables = metadata.tables
    record_ids = set(bind.execute(sa.text("SELECT id FROM records")).scalars())
    grouped = {kind: [] for kind in KINDS}
    for row in rows:
        grouped[row["kind"]].append(row)

    device_ids: set[str] = set()
    command_ids: set[str] = set()
    used_source_commands: set[str] = set()
    used_artifacts: set[str] = set()

    for row in grouped["desktopDevices"]:
        data = _json(row["data"])
        _insert(tables["desktop_devices"], {
            **_common(data, row), "device_name": _text(data.get("deviceName")),
            "platform": _text(data.get("platform") or "windows"), "app_version": _text(data.get("appVersion")),
            "public_key": _text(data.get("publicKey")), "device_token_hash": _text(data.get("deviceTokenHash")),
            "last_seen_at": _timestamp(data.get("lastSeenAt")) if data.get("lastSeenAt") else None,
        })
        device_ids.add(row["id"])

    for row in grouped["desktopCommands"]:
        data = _json(row["data"])
        _insert(tables["desktop_commands"], {
            **_common(data, row), "device_id": _optional(data.get("deviceId"), device_ids),
            "media_account_id": _optional(data.get("mediaAccountId"), record_ids),
            "command_type": _text(data.get("type") or "unknown"),
            "payload": data.get("payload") if isinstance(data.get("payload"), dict) else {},
            "result": data.get("result") if isinstance(data.get("result"), dict) else {},
            "error_message": _text(data.get("errorMessage")),
        })
        command_ids.add(row["id"])

    for row in grouped["mediaOrders"]:
        data = _json(row["data"])
        source_command_id = _optional(data.get("sourceCommandId"), command_ids)
        if source_command_id in used_source_commands:
            source_command_id = None
        elif source_command_id:
            used_source_commands.add(source_command_id)
        _insert(tables["media_orders"], {
            **_common(data, row), "article_id": _optional(data.get("articleId"), record_ids),
            "media_account_id": _optional(data.get("mediaAccountId"), record_ids), "source_command_id": source_command_id,
            "platform": _text(data.get("platform")), "backlink_url": _text(data.get("backlinkUrl")),
            "review_status": _text(data.get("reviewStatus")), "error_message": _text(data.get("errorMessage")),
        })

    for row in grouped["mediaAccountBindings"]:
        data = _json(row["data"])
        artifact_id = _optional(data.get("artifactId"))
        if artifact_id in used_artifacts:
            artifact_id = None
        elif artifact_id:
            used_artifacts.add(artifact_id)
        _insert(tables["media_account_bindings"], {
            **_common(data, row), "media_account_id": _optional(data.get("mediaAccountId"), record_ids),
            "device_id": _optional(data.get("deviceId"), device_ids), "session_id": _text(data.get("sessionId")),
            "artifact_id": artifact_id, "platform": _text(data.get("platform")), "profile_key": _text(data.get("profileKey")),
        })

    for row in grouped["tasks"]:
        data = _json(row["data"])
        common = _common(data, row)
        retry_count = _integer(data.get("retryCount"))
        _insert(tables["task_jobs"], {
            **common, "task_type": _text(data.get("type") or "unknown"), "queue_name": _text(data.get("queue") or "default"),
            "progress": _integer(data.get("progress")), "payload": data.get("payload") if isinstance(data.get("payload"), dict) else {},
            "error_message": _text(data.get("errorMessage")),
        })
        terminal = common["status"] in {"succeeded", "failed", "cancelled"}
        _insert(tables["task_attempts"], {
            "id": f"{row['id']}:{retry_count}", "task_job_id": row["id"], "attempt_number": retry_count,
            "status": common["status"], "error_message": _text(data.get("errorMessage")), "data": data,
            "started_at": common["updated_at"] if common["status"] == "running" else None,
            "finished_at": common["updated_at"] if terminal else None,
            "created_at": common["created_at"], "updated_at": common["updated_at"],
        })


def upgrade() -> None:
    _create_tables()
    _backfill()


def downgrade() -> None:
    for table_name in ("media_account_bindings", "media_orders", "desktop_commands", "desktop_devices", "task_attempts", "task_jobs"):
        op.drop_table(table_name)