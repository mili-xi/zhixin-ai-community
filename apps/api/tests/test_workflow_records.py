from pathlib import Path
import os
import logging

os.environ["DATABASE_URL"] = f"sqlite:///{Path(__file__).parent / 'test.sqlite'}"

from sqlalchemy import text

from app.database import Base, SessionLocal, engine
from app.models.workflows import DesktopCommand, DesktopDevice, MediaOrder, TaskAttempt, TaskJob
from app.service import delete_record, patch_record, save_record


def setup_function():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    with engine.connect() as connection:
        connection.execute(text("PRAGMA foreign_keys=ON"))


def test_task_job_is_persisted_before_its_first_attempt():
    with SessionLocal() as db:
        task = save_record(db, "tasks", {
            "id": "task-fk-order-1",
            "type": "ai-generate-article",
            "queue": "ai",
            "status": "queued",
            "retryCount": 0,
            "payload": {"keyword": "AI SEO"},
        })

        assert db.get(TaskJob, task["id"]) is not None
        assert db.get(TaskAttempt, f"{task['id']}:0").task_job_id == task["id"]


def test_critical_records_dual_write_and_patch_relational_tables():
    with SessionLocal() as db:
        article = save_record(db, "articles", {"id": "article-rel-1", "title": "Relational article"})
        account = save_record(db, "mediaAccounts", {"id": "account-rel-1", "platform": "zhihu"})
        device = save_record(db, "desktopDevices", {
            "id": "device-rel-1",
            "deviceName": "Desktop",
            "platform": "windows",
            "appVersion": "0.1.0",
            "deviceTokenHash": "hash",
            "status": "active",
        })
        command = save_record(db, "desktopCommands", {
            "id": "command-rel-1",
            "deviceId": device["id"],
            "mediaAccountId": account["id"],
            "type": "publish_article",
            "status": "queued",
            "payload": {"articleId": article["id"]},
        })
        order = save_record(db, "mediaOrders", {
            "id": "order-rel-1",
            "articleId": article["id"],
            "mediaAccountId": account["id"],
            "sourceCommandId": command["id"],
            "platform": "zhihu",
            "status": "pending",
        })
        task = save_record(db, "tasks", {
            "id": "task-rel-1",
            "type": "publish-and-index",
            "queue": "publish",
            "status": "queued",
            "retryCount": 0,
            "payload": {"articleId": article["id"]},
        })

        assert db.get(DesktopDevice, device["id"]).status == "active"
        assert db.get(DesktopCommand, command["id"]).device_id == device["id"]
        assert db.get(MediaOrder, order["id"]).source_command_id == command["id"]
        assert db.get(TaskJob, task["id"]).queue_name == "publish"
        assert db.get(TaskAttempt, f"{task['id']}:0").status == "queued"

        patch_record(db, "tasks", task["id"], {"status": "failed", "errorMessage": "provider failed"})
        db.expire_all()
        assert db.get(TaskJob, task["id"]).status == "failed"
        assert db.get(TaskAttempt, f"{task['id']}:0").error_message == "provider failed"


def test_deleting_critical_record_removes_compatibility_mirror():
    with SessionLocal() as db:
        saved = save_record(db, "desktopDevices", {
            "id": "device-delete-1",
            "deviceName": "Disposable",
            "status": "offline",
        })
        assert db.get(DesktopDevice, saved["id"]) is not None

        assert delete_record(db, "desktopDevices", saved["id"]) is True
        assert db.get(DesktopDevice, saved["id"]) is None


def test_media_order_refuses_a_reference_to_an_article_that_is_gone():
    """A dead article id must never reach the media_orders foreign key.

    Deleting an article nulls the mirrored column but leaves the id inside the
    record JSON, so the next write used to re-inject it and fail the commit
    inside save_record's silent fallback -- ten review orders sat frozen for two
    months because of exactly that.
    """
    with SessionLocal() as db:
        order = save_record(db, "mediaOrders", {
            "id": "order-dead-article",
            "articleId": "article-never-existed",
            "platform": "zhihu",
            "status": "review_required",
            "reviewStatus": "pending_public_visibility",
        })

        assert order["articleId"] == "article-never-existed"
        assert db.get(MediaOrder, order["id"]).article_id is None


def test_patching_an_order_whose_article_was_deleted_still_lands():
    with SessionLocal() as db:
        article = save_record(db, "articles", {"id": "article-doomed", "title": "Doomed"})
        save_record(db, "mediaOrders", {
            "id": "order-orphaned",
            "articleId": article["id"],
            "platform": "zhihu",
            "status": "review_required",
            "reviewStatus": "pending_public_visibility",
        })
        assert db.get(MediaOrder, "order-orphaned").article_id == article["id"]

        delete_record(db, "articles", article["id"])

        patched = patch_record(db, "mediaOrders", "order-orphaned", {
            "publicDiscoveryStatus": "failed",
            "backlinkStatus": "blocked",
            "errorMessage": "Publication discovery skipped: source article no longer exists.",
        })

        assert patched["publicDiscoveryStatus"] == "failed"
        assert patched["backlinkStatus"] == "blocked"
        assert db.get(MediaOrder, "order-orphaned").article_id is None


def test_integrity_conflict_is_logged_instead_of_swallowed(caplog):
    """A write that never landed has to leave a trace.

    Two orders claiming the same source command is the cheapest way to make the
    commit fail while the record still exists, which is the shape of the
    production failure: save_record rolled back, returned the old row, and the
    caller carried on as if the write had succeeded.
    """
    with caplog.at_level(logging.ERROR, logger="app.service"):
        with SessionLocal() as db:
            command = save_record(db, "desktopCommands", {
                "id": "command-shared",
                "type": "publish_article",
                "status": "queued",
            })
            save_record(db, "mediaOrders", {
                "id": "order-owner-of-command",
                "sourceCommandId": command["id"],
                "platform": "zhihu",
                "status": "pending",
            })
            save_record(db, "mediaOrders", {
                "id": "order-second-claimant",
                "platform": "zhihu",
                "status": "pending",
            })

            stale = patch_record(db, "mediaOrders", "order-second-claimant", {
                "sourceCommandId": command["id"],
                "platform": "jianshu",
            })

    assert stale["platform"] == "zhihu"
    assert "order-second-claimant" in caplog.text
    assert "integrity conflict" in caplog.text
