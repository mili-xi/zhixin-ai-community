from datetime import datetime, timezone
from types import SimpleNamespace
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from app.database import Record, Base
from app.models.workflows import TaskJob
from app.repositories.workflow_records import sync_workflow_record
from app.queue_reconciliation import reconcile_queue_state
from app.worker import TaskExecutor

@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        yield session
    engine.dispose()

def put(db, id, kind, **data):
    row = Record(id=id, kind=kind, owner_id="owner", data={"id": id, "ownerId": "owner", **data})
    db.add(row)
    sync_workflow_record(db, kind, row.data)
    db.commit()
    return row

def queue(task="t"):
    return SimpleNamespace(dead_letters=lambda name: [SimpleNamespace(payload={"taskId": task}, last_error="QUEUE_LEASE_EXPIRED")])

def test_dead_task_and_batch_terminal_and_no_replay(db):
    task = put(db, "t", "tasks", status="queued", payload={"autoPublishTaskId": "b"})
    batch = put(db, "b", "autoPublishTasks", status="queued")
    reconcile_queue_state(db, queue(), ["publish"])
    assert task.data["status"] == batch.data["status"] == "failed"
    assert db.get(TaskJob, "t").status == "failed"
    assert db.get(TaskJob, "t").owner_id == "owner"
    executor = TaskExecutor(db, queue())
    executor.dispatch = lambda task: pytest.fail("must not replay")
    assert executor.run_task("t")["queueTerminal"] is True

def test_live_command_not_failed_or_replayed_and_old_running_is_unknown(db):
    task = put(db, "t", "tasks", status="queued", payload={"autoPublishTaskId": "b"})
    batch = put(db, "b", "autoPublishTasks", status="publishing")
    command = put(db, "c", "desktopCommands", type="publish_article", status="running", updatedAt="2026-10-01T00:00:00Z", payload={"autoPublishTaskId":"b"})
    reconcile_queue_state(db, queue(), ["publish"], now=datetime(2026,11,2,tzinfo=timezone.utc))
    assert task.data["status"] == "queued"
    assert task.data["queueTerminal"] is True
    assert command.data["status"] == "running"
    assert batch.data["status"] == "manual_action_required"

def test_canceled_command_finishes_batch(db):
    batch = put(db, "b", "autoPublishTasks", status="publishing")
    put(db, "c", "desktopCommands", type="publish_article", status="canceled", payload={"autoPublishTaskId":"b"})
    reconcile_queue_state(db, queue("missing"), ["publish"])
    assert batch.data["status"] == "failed"
    assert batch.data["publishPendingCount"] == 0

def test_queue_failure_rolls_back_pending_reconciliation(db):
    task = put(db, "t", "tasks", status="queued")
    def read(name):
        if name == "bad": raise RuntimeError("unavailable")
        return queue().dead_letters(name)
    with pytest.raises(RuntimeError):
        reconcile_queue_state(db, SimpleNamespace(dead_letters=read), ["ok", "bad"])
    db.refresh(task)
    assert task.data["status"] == "queued"
    assert db.is_active


@pytest.mark.parametrize("status", ["succeeded", "canceled", "cancelled"])
def test_terminal_tasks_never_dispatch(db, status):
    put(db, "t", "tasks", status=status)
    executor = TaskExecutor(db, queue())
    executor.dispatch = lambda task: pytest.fail("terminal task replayed")
    assert executor.run_task("t")["status"] == status

def test_latest_attempt_controls_batch(db):
    batch = put(db, "b", "autoPublishTasks", status="publishing")
    for id, status, attempt in [("old", "failed", 1), ("new", "succeeded", 2)]:
        put(db, id, "desktopCommands", type="publish_article", status=status,
            payload={"autoPublishTaskId":"b", "dedupeKey":"same", "attempt":attempt})
    reconcile_queue_state(db, queue("missing"), ["publish"])
    assert batch.data["status"] == "succeeded"
    assert batch.data["desktopCommandIds"] == ["new"]


def test_repeated_reconciliation_does_not_rewrite_terminal_records(db):
    task = put(db, "t", "tasks", status="queued", payload={"autoPublishTaskId":"b"})
    batch = put(db, "b", "autoPublishTasks", status="queued")
    reconcile_queue_state(db, queue(), ["publish"])
    before = (dict(task.data), dict(batch.data), db.get(TaskJob,"t").updated_at)
    reconcile_queue_state(db, queue(), ["publish"])
    assert before == (task.data, batch.data, db.get(TaskJob,"t").updated_at)


def test_old_dead_letter_does_not_terminalize_new_retry(db):
    task = put(db, "t", "tasks", status="queued", retryCount=1)
    reconcile_queue_state(db, queue(), ["publish"])
    assert task.data["status"] == "queued"
    assert not task.data.get("queueTerminal")

def test_terminal_retry_rejected_before_enqueue(db, monkeypatch):
    from app import service
    from fastapi import HTTPException
    put(db, "t", "tasks", status="failed", queueTerminal=True)
    monkeypatch.setattr(service.queue_client, "enqueue", lambda *a: pytest.fail("must not enqueue"))
    with pytest.raises(HTTPException) as error:
        service.retry_task(db, "t")
    assert error.value.status_code == 409

@pytest.mark.parametrize("result", [
    {"platformStatus":"manual_verification_required"},
    {"message":"MANUAL_ACTION_REQUIRED"},
])
def test_manual_verification_failure_preserves_manual_batch(db, result):
    batch = put(db, "b", "autoPublishTasks", status="publishing")
    put(db, "c", "desktopCommands", type="publish_article", status="failed", result=result,
        payload={"autoPublishTaskId":"b"})
    reconcile_queue_state(db, queue("missing"), ["publish"])
    assert batch.data["status"] == "manual_action_required"
