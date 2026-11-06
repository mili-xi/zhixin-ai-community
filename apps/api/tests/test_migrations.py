from pathlib import Path

import logging

from alembic import command
from alembic.config import Config
import pytest
from sqlalchemy import JSON, bindparam, create_engine, inspect, text

from app.database import assert_database_migrated
from app.migrations import resolve_migration_database_url


def alembic_config(database_url: str) -> Config:
    root = Path(__file__).resolve().parents[1]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "alembic"))
    config.set_main_option("sqlalchemy.url", database_url)
    return config


def test_migration_database_url_uses_environment_when_config_is_empty(monkeypatch):
    container_url = "postgresql+psycopg://zhixin:zhixin@postgres:5432/zhixin_ai"
    monkeypatch.setenv("DATABASE_URL", container_url)

    assert resolve_migration_database_url("") == container_url


def test_migration_database_url_preserves_explicit_config_over_environment(monkeypatch, tmp_path):
    sqlite_url = f"sqlite:///{tmp_path / 'explicit.sqlite'}"
    monkeypatch.setenv(
        "DATABASE_URL",
        "postgresql+psycopg://zhixin:zhixin@postgres:5432/zhixin_ai",
    )

    assert resolve_migration_database_url(sqlite_url) == sqlite_url


def test_alembic_upgrade_and_critical_table_rollback(tmp_path):
    database_url = f"sqlite:///{tmp_path / 'migration.sqlite'}"
    config = alembic_config(database_url)

    command.upgrade(config, "head")
    engine = create_engine(database_url)
    tables = set(inspect(engine).get_table_names())
    assert {
        "records", "task_jobs", "task_attempts", "media_orders",
        "desktop_devices", "desktop_commands", "media_account_bindings",
        "users", "email_login_codes", "email_verification_codes", "web_sessions", "alembic_version",
    }.issubset(tables)
    assert "owner_id" in {column["name"] for column in inspect(engine).get_columns("records")}
    assert {"password_hash", "password_changed_at"}.issubset(
        {column["name"] for column in inspect(engine).get_columns("users")}
    )
    assert_database_migrated(engine)

    command.downgrade(config, "0001_records_baseline")
    rolled_back = set(inspect(engine).get_table_names())
    assert "records" in rolled_back
    assert "task_jobs" not in rolled_back
    assert "desktop_commands" not in rolled_back
    with pytest.raises(RuntimeError, match="DATABASE_MIGRATION_OUTDATED"):
        assert_database_migrated(engine)


def test_existing_records_are_backfilled_into_relational_mirrors(tmp_path):
    database_url = f"sqlite:///{tmp_path / 'backfill.sqlite'}"
    config = alembic_config(database_url)
    command.upgrade(config, "0001_records_baseline")
    engine = create_engine(database_url)

    records = [
        {"id": "article-1", "kind": "articles", "data": {"id": "article-1", "title": "Article"}},
        {"id": "account-1", "kind": "mediaAccounts", "data": {"id": "account-1", "platform": "zhihu"}},
        {"id": "device-1", "kind": "desktopDevices", "data": {"id": "device-1", "deviceName": "Desktop", "status": "active"}},
        {"id": "command-1", "kind": "desktopCommands", "data": {"id": "command-1", "deviceId": "device-1", "mediaAccountId": "account-1", "type": "publish_article", "status": "queued"}},
        {"id": "order-1", "kind": "mediaOrders", "data": {"id": "order-1", "articleId": "article-1", "mediaAccountId": "account-1", "sourceCommandId": "command-1", "platform": "zhihu", "status": "reviewing"}},
        {"id": "binding-1", "kind": "mediaAccountBindings", "data": {"id": "binding-1", "mediaAccountId": "account-1", "deviceId": "device-1", "sessionId": "session-1", "platform": "zhihu", "status": "active"}},
        {"id": "task-1", "kind": "tasks", "data": {"id": "task-1", "type": "publish", "queue": "publish", "status": "failed", "retryCount": 2, "errorMessage": "failed"}},
    ]
    statement = text("INSERT INTO records (id, kind, data) VALUES (:id, :kind, :data)").bindparams(bindparam("data", type_=JSON()))
    with engine.begin() as connection:
        connection.execute(statement, records)

    command.upgrade(config, "head")
    with engine.connect() as connection:
        assert connection.execute(text("SELECT device_id FROM desktop_commands WHERE id='command-1'")).scalar_one() == "device-1"
        assert connection.execute(text("SELECT source_command_id FROM media_orders WHERE id='order-1'")).scalar_one() == "command-1"
        assert connection.execute(text("SELECT attempt_number FROM task_attempts WHERE task_job_id='task-1'")).scalar_one() == 2
        assert connection.execute(text("SELECT status FROM media_account_bindings WHERE id='binding-1'")).scalar_one() == "active"
        assert connection.execute(text("SELECT owner_id FROM records WHERE id='article-1'")).scalar_one() == "legacy-internal-owner"


def test_running_migrations_does_not_disable_application_loggers(tmp_path):
    import app.service  # noqa: F401 -- registering the logger is the point of this test

    database_url = f"sqlite:///{tmp_path / 'loggers.sqlite'}"
    command.upgrade(alembic_config(database_url), "head")

    # fileConfig used to disable every logger absent from alembic.ini, which made
    # the integrity-conflict error in app.service invisible in production.
    assert logging.getLogger("app.service").disabled is False
