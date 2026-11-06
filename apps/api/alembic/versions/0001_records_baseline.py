"""Adopt the existing generic records table without destructive changes."""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision = "0001_records_baseline"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    if "records" not in inspector.get_table_names():
        op.create_table(
            "records",
            sa.Column("id", sa.String(length=120), primary_key=True),
            sa.Column("kind", sa.String(length=80), nullable=False),
            sa.Column("data", sa.JSON(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        )
        op.create_index("ix_records_kind", "records", ["kind"], unique=False)
        return

    indexes = {item["name"] for item in inspector.get_indexes("records")}
    if "ix_records_kind" not in indexes:
        op.create_index("ix_records_kind", "records", ["kind"], unique=False)


def downgrade() -> None:
    # This is an adoption baseline. Keep records intact when rolling back newer
    # relational mirrors so existing installations never lose compatibility data.
    pass