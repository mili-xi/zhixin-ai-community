from __future__ import annotations

from datetime import datetime

from sqlalchemy import JSON, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from .base import Base


class WorkflowRecordMixin:
    id: Mapped[str] = mapped_column(String(120), primary_key=True)
    owner_id: Mapped[str] = mapped_column(String(120), nullable=False, default="legacy-internal-owner", index=True)
    status: Mapped[str] = mapped_column(String(80), nullable=False, default="pending", index=True)
    data: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)


class TaskJob(WorkflowRecordMixin, Base):
    __tablename__ = "task_jobs"
    __table_args__ = (Index("ix_task_jobs_queue_status", "queue_name", "status"),)

    task_type: Mapped[str] = mapped_column(String(120), nullable=False, index=True)
    queue_name: Mapped[str] = mapped_column(String(80), nullable=False, default="default")
    progress: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    payload: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    error_message: Mapped[str] = mapped_column(Text, nullable=False, default="")


class TaskAttempt(Base):
    __tablename__ = "task_attempts"
    __table_args__ = (
        UniqueConstraint("task_job_id", "attempt_number", name="uq_task_attempt_job_number"),
        Index("ix_task_attempts_job_status", "task_job_id", "status"),
    )

    id: Mapped[str] = mapped_column(String(180), primary_key=True)
    task_job_id: Mapped[str] = mapped_column(ForeignKey("task_jobs.id", ondelete="CASCADE"), nullable=False)
    attempt_number: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    status: Mapped[str] = mapped_column(String(80), nullable=False, default="queued")
    error_message: Mapped[str] = mapped_column(Text, nullable=False, default="")
    data: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)


class DesktopDevice(WorkflowRecordMixin, Base):
    __tablename__ = "desktop_devices"

    device_name: Mapped[str] = mapped_column(String(200), nullable=False, default="")
    platform: Mapped[str] = mapped_column(String(80), nullable=False, default="windows", index=True)
    app_version: Mapped[str] = mapped_column(String(80), nullable=False, default="")
    public_key: Mapped[str] = mapped_column(Text, nullable=False, default="")
    device_token_hash: Mapped[str] = mapped_column(String(160), nullable=False, default="")
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class DesktopCommand(WorkflowRecordMixin, Base):
    __tablename__ = "desktop_commands"
    __table_args__ = (Index("ix_desktop_commands_device_status", "device_id", "status"),)

    device_id: Mapped[str | None] = mapped_column(ForeignKey("desktop_devices.id", ondelete="SET NULL"), nullable=True, index=True)
    media_account_id: Mapped[str | None] = mapped_column(ForeignKey("records.id", ondelete="SET NULL"), nullable=True, index=True)
    command_type: Mapped[str] = mapped_column(String(120), nullable=False, index=True)
    payload: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    result: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    error_message: Mapped[str] = mapped_column(Text, nullable=False, default="")


class MediaOrder(WorkflowRecordMixin, Base):
    __tablename__ = "media_orders"
    __table_args__ = (
        UniqueConstraint("source_command_id", name="uq_media_orders_source_command"),
        Index("ix_media_orders_platform_status", "platform", "status"),
    )

    article_id: Mapped[str | None] = mapped_column(ForeignKey("records.id", ondelete="SET NULL"), nullable=True, index=True)
    media_account_id: Mapped[str | None] = mapped_column(ForeignKey("records.id", ondelete="SET NULL"), nullable=True, index=True)
    source_command_id: Mapped[str | None] = mapped_column(ForeignKey("desktop_commands.id", ondelete="SET NULL"), nullable=True)
    platform: Mapped[str] = mapped_column(String(80), nullable=False, default="", index=True)
    backlink_url: Mapped[str] = mapped_column(Text, nullable=False, default="")
    review_status: Mapped[str] = mapped_column(String(100), nullable=False, default="")
    error_message: Mapped[str] = mapped_column(Text, nullable=False, default="")


class MediaAccountBinding(WorkflowRecordMixin, Base):
    __tablename__ = "media_account_bindings"
    __table_args__ = (
        UniqueConstraint("artifact_id", name="uq_media_account_bindings_artifact"),
        Index("ix_media_account_bindings_account_status", "media_account_id", "status"),
    )

    media_account_id: Mapped[str | None] = mapped_column(ForeignKey("records.id", ondelete="CASCADE"), nullable=True, index=True)
    device_id: Mapped[str | None] = mapped_column(ForeignKey("desktop_devices.id", ondelete="SET NULL"), nullable=True, index=True)
    session_id: Mapped[str] = mapped_column(String(160), nullable=False, default="", index=True)
    artifact_id: Mapped[str | None] = mapped_column(String(160), nullable=True)
    platform: Mapped[str] = mapped_column(String(80), nullable=False, default="", index=True)
    profile_key: Mapped[str] = mapped_column(String(200), nullable=False, default="")