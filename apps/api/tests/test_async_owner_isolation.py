from app.auth.context import ActorContext, ActorRole, actor_scope, current_owner_id
from app.database import Base, SessionLocal, engine
from app.queue import MemoryQueueClient
from app.service import create_task, get_record, list_records, save_record
from app.worker import Scheduler, TaskExecutor


def setup_function() -> None:
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)


def member(owner_id: str) -> ActorContext:
    return ActorContext(user_id=owner_id, role=ActorRole.MEMBER)


def test_created_task_propagates_owner_and_worker_restores_it() -> None:
    queue = MemoryQueueClient()
    captured_owners: list[str | None] = []

    class CapturingExecutor(TaskExecutor):
        def dispatch(self, task: dict) -> dict:
            captured_owners.append(current_owner_id())
            return {"observedOwnerId": current_owner_id(), "taskOwnerId": task.get("ownerId")}

    with SessionLocal() as db:
        with actor_scope(member("member-a")):
            task = create_task(db, "owner-probe", "Owner probe", {}, queue_backend=queue)

        queued = queue.reserve(["default"], timeout=0)
        assert queued is not None
        assert queued.payload["ownerId"] == "member-a"
        queue.nack(queued, "return to queue")

        result = CapturingExecutor(db, queue).run_next(["default"], timeout=0)

        assert result is not None
        assert result["status"] == "succeeded"
        assert captured_owners == ["member-a"]
        with actor_scope(member("member-a")):
            assert get_record(db, "tasks", task["id"])["result"]["observedOwnerId"] == "member-a"


def test_worker_rejects_queue_owner_that_does_not_match_task_record() -> None:
    queue = MemoryQueueClient()

    with SessionLocal() as db:
        with actor_scope(member("member-a")):
            task = save_record(db, "tasks", {
                "id": "task-owner-mismatch",
                "type": "owner-probe",
                "title": "Owner mismatch",
                "status": "queued",
                "queue": "default",
                "payload": {},
            })
        queue.enqueue("default", {"taskId": task["id"], "ownerId": "member-b"})

        result = TaskExecutor(db, queue).run_next(["default"], timeout=0)

        assert result == {"status": "failed", "errorMessage": "QUEUE_OWNER_MISMATCH"}
        with actor_scope(member("member-a")):
            assert get_record(db, "tasks", task["id"])["status"] == "queued"

def test_scheduler_partitions_due_jobs_by_record_owner() -> None:
    queue = MemoryQueueClient()

    with SessionLocal() as db:
        with actor_scope(member("member-a")):
            save_record(db, "knowledgeItems", {
                "id": "knowledge-a",
                "title": "Knowledge A",
                "source": "web",
                "url": "https://example.com/a",
                "refreshMode": "scheduled",
            })
        with actor_scope(member("member-b")):
            save_record(db, "knowledgeItems", {
                "id": "knowledge-b",
                "title": "Knowledge B",
                "source": "web",
                "url": "https://example.com/b",
                "refreshMode": "scheduled",
            })

        result = Scheduler(db, queue).enqueue_due_jobs()

        assert result["knowledgeRefresh"] == 2
        first = queue.reserve(["knowledge"], timeout=0)
        second = queue.reserve(["knowledge"], timeout=0)
        assert first is not None and second is not None
        assert {first.payload["ownerId"], second.payload["ownerId"]} == {"member-a", "member-b"}
        with actor_scope(member("member-a")):
            assert len([task for task in list_records(db, "tasks") if task["type"] == "knowledge-fetch-url"]) == 1
        with actor_scope(member("member-b")):
            assert len([task for task in list_records(db, "tasks") if task["type"] == "knowledge-fetch-url"]) == 1
