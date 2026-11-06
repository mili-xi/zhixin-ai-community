from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app import service
from app.auth.context import ActorContext, ActorRole, actor_scope
from app.database import Record


def test_dashboard_reads_failed_and_recent_tasks_without_loading_success_history(monkeypatch):
    engine = create_engine("sqlite://")
    Record.__table__.create(engine)
    with Session(engine) as db:
        for i in range(30):
            data = {"id": f"task-{i:02}", "status": "failed" if i == 1 else "succeeded", "result": {"text": "long history"}}
            db.add(Record(id=data["id"], kind="tasks", owner_id="owner", data=data))
        db.add(Record(id="foreign", kind="tasks", owner_id="other", data={"id": "foreign", "status": "failed"}))
        for i, (kind, status, owner) in enumerate([
            ("publish_article", "queued", "owner"), ("publish_article", "running", "owner"),
            ("publish_article", "succeeded", "owner"), ("validate_session", "running", "owner"),
            ("publish_article", "queued", "other"),
        ]):
            db.add(Record(id=f"command-{i}", kind="desktopCommands", owner_id=owner, data={"type": kind, "status": status}))
        db.commit()
        normalize = service.normalize_timestamps

        def checked(data):
            assert data.get("id") not in {f"task-{i:02}" for i in range(22) if i != 1} | {"foreign"}
            return normalize(data)

        monkeypatch.setattr(service, "normalize_timestamps", checked)
        with actor_scope(ActorContext(user_id="owner", role=ActorRole.MEMBER)):
            failed, recent = service.dashboard_task_records(db)
            running = service.dashboard_running_publish_count(db)
        assert [row["id"] for row in failed] == ["task-01"]
        assert [row["id"] for row in recent] == [f"task-{i:02}" for i in range(22, 30)]
        assert running == 2
