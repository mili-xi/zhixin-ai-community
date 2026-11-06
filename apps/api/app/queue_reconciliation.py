"""Conservative queue/database reconciliation; never dispatch or replay publication."""
from datetime import datetime, timezone, timedelta
from sqlalchemy import select
from .database import Record
from .repositories.workflow_records import sync_workflow_record
from .app_time import now_stamp


def _update(db, record, **values):
    if all(record.data.get(key) == value for key, value in values.items()):
        return False
    record.data = {**record.data, **values, "id": record.id, "ownerId": record.owner_id, "updatedAt": now_stamp()}
    sync_workflow_record(db, record.kind, record.data)
    return True


def _commands(db, batch):
    rows = db.scalars(select(Record).where(
        Record.kind == "desktopCommands", Record.owner_id == batch.owner_id,
        Record.data["payload"]["autoPublishTaskId"].as_string() == batch.id,
        Record.data["type"].as_string() == "publish_article",
    ).order_by(Record.created_at, Record.id)).all()
    latest = {}
    for row in rows:
        d = row.data
        p = d.get("payload") or {}
        key = p.get("dedupeKey") or (f"{p.get('articleId')}:{d.get('mediaAccountId')}" if p.get("articleId") and d.get("mediaAccountId") else row.id)
        rank = int(p.get("attempt") or 1)
        if key not in latest or rank >= latest[key][0]:
            latest[key] = (rank, row)
    return [value[1] for value in latest.values()]


def reconcile_queue_state(db, queue, queues, now=None):
    now = now or datetime.now(timezone.utc)
    changed = 0
    try:
        for name in queues:
            for message in queue.dead_letters(name):
                task = db.get(Record, str(message.payload.get("taskId") or ""))
                if not task or task.kind != "tasks" or task.data.get("queueTerminal") or task.data.get("status") in {"succeeded", "canceled", "cancelled"}:
                    continue
                if message.payload.get("ownerId") and message.payload["ownerId"] != task.owner_id:
                    continue
                # queueResult contains no message ID. Explicit retries carry their
                # generation in the queue payload; lease attempts are unrelated.
                original_payload = message.payload.get("payload") or {}
                generation = message.payload.get("retryCount", original_payload.get("retryCount", 0))
                if int(generation or 0) != int(task.data.get("retryCount") or 0):
                    continue
                p = task.data.get("payload") or {}
                batch = db.get(Record, str(p.get("autoPublishTaskId") or ""))
                if batch and (batch.kind != "autoPublishTasks" or batch.owner_id != task.owner_id):
                    continue
                commands = _commands(db, batch) if batch else db.scalars(select(Record).where(
                    Record.kind == "desktopCommands", Record.owner_id == task.owner_id,
                    Record.data["payload"]["taskId"].as_string() == task.id,
                )).all()
                if commands or (task.data.get("result") or {}).get("desktopCommandId"):
                    # A dead queue message cannot authorize a second dispatch.
                    # Preserve outcome uncertainty while blocking replay.
                    _update(db, task, queueTerminal=True, stage="publication_result_unknown")
                    continue
                _update(db, task, status="failed", stage="dead_letter", queueTerminal=True,
                        errorMessage=message.last_error or "QUEUE_DEAD_LETTERED")
                if batch:
                    _update(db, batch, status="failed", lastError=message.last_error or "QUEUE_DEAD_LETTERED", publishPendingCount=0)
                changed += 1
        batches = db.scalars(select(Record).where(
            Record.kind == "autoPublishTasks",
            Record.data["status"].as_string().in_(["queued", "running", "publishing", "manual_action_required"]),
        )).all()
        for batch in batches:
            commands = _commands(db, batch)
            if not commands:
                continue
            states = [c.data.get("status") for c in commands]
            succeeded = states.count("succeeded")
            failed = sum(s in {"failed", "canceled", "cancelled"} for s in states)
            pending = len(states) - succeeded - failed
            manual = any(
                (c.data.get("result") or {}).get("platformStatus") == "manual_verification_required"
                or any(marker in (str(c.data.get("errorMessage") or "") + " " + str((c.data.get("result") or {}).get("message") or "") + " " + str((c.data.get("result") or {}).get("platformStatus") or "")).upper()
                       for marker in ("MANUAL_ACTION_REQUIRED", "MANUAL_VERIFICATION_REQUIRED"))
                for c in commands
            )
            uncertain = False
            for command in commands:
                if command.data.get("status") != "running":
                    continue
                try:
                    stamp = datetime.fromisoformat(str(command.data.get("updatedAt") or command.data.get("createdAt")).replace("Z", "+00:00"))
                    if stamp.tzinfo is not None and now - stamp > timedelta(hours=24):
                        uncertain = True
                except (ValueError, TypeError):
                    pass
            if pending and not uncertain and not manual:
                continue
            status = "manual_action_required" if uncertain or manual else "partial_failed" if failed and succeeded else "failed" if failed else "succeeded"
            _update(db, batch, status=status, publishPendingCount=pending, publishSucceededCount=succeeded,
                    publishFailedCount=failed, desktopCommandIds=[c.id for c in commands],
                    **({"lastError": "PUBLICATION_RESULT_UNKNOWN: long-running desktop command requires manual verification; do not republish"} if uncertain else {}))
            changed += 1
        db.commit()
        return changed
    except Exception:
        db.rollback()
        raise
