"""Add owner isolation to generic records and workflow mirrors."""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0004_owner_isolation"
down_revision = "0003_internal_auth"
branch_labels = None
depends_on = None

LEGACY_OWNER_ID = "legacy-internal-owner"
WORKFLOW_TABLES = (
    "task_jobs",
    "desktop_devices",
    "desktop_commands",
    "media_orders",
    "media_account_bindings",
)


def upgrade() -> None:
    op.add_column(
        "records",
        sa.Column(
            "owner_id",
            sa.String(length=120),
            nullable=False,
            server_default=LEGACY_OWNER_ID,
        ),
    )
    op.create_index("ix_records_owner_id", "records", ["owner_id"])
    op.create_index("ix_records_owner_kind", "records", ["owner_id", "kind"])

    for table_name in WORKFLOW_TABLES:
        op.execute(sa.text(
            f"UPDATE {table_name} SET owner_id = "
            f"COALESCE((SELECT owner_id FROM records WHERE records.id = {table_name}.id), :legacy_owner) "
            "WHERE owner_id = 'default' OR owner_id = ''"
        ).bindparams(legacy_owner=LEGACY_OWNER_ID))


def downgrade() -> None:
    op.drop_index("ix_records_owner_kind", table_name="records")
    op.drop_index("ix_records_owner_id", table_name="records")
    op.drop_column("records", "owner_id")
