import asyncio
import threading
from contextlib import nullcontext
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from starlette.requests import Request
from starlette.responses import Response

from app.auth import middleware
from app.auth.context import ActorContext, ActorRole, actor_scope, current_owner_id
from app.database import Record
from app import service


@pytest.mark.parametrize("credential", ["cookie", "device", "invalid-device"])
def test_authentication_database_work_does_not_block_event_loop(monkeypatch, credential):
    loop_thread = threading.get_ident()
    db_threads = []
    actor = ActorContext(user_id="owner", role=ActorRole.MEMBER)

    def session():
        db_threads.append(threading.get_ident())
        return nullcontext(object())

    def device_actor(*args):
        if credential == "invalid-device":
            raise HTTPException(403, "DESKTOP_DEVICE_AUTH_REQUIRED")
        return actor

    monkeypatch.setattr(middleware, "SessionLocal", session)
    monkeypatch.setattr(middleware, "resolve_web_session", lambda *args: (object(), object()))
    monkeypatch.setattr(middleware, "actor_for_user", lambda user: actor)
    monkeypatch.setattr(middleware, "desktop_actor_for_device", device_actor)
    monkeypatch.setattr(middleware, "get_settings", lambda: SimpleNamespace(auth_cookie_name="session", auth_test_bypass_user_id=""))
    headers = [(b"cookie", b"session=test")] if credential == "cookie" else [(b"x-device-id", b"device"), (b"x-device-token", b"token")]
    request = Request({"type": "http", "method": "GET", "path": "/api/published-center", "headers": headers})

    async def next_handler(request):
        assert current_owner_id() == "owner"
        return Response(status_code=200)

    response = asyncio.run(middleware.AuthenticationMiddleware(None).dispatch(request, next_handler))
    assert response.status_code == (403 if credential == "invalid-device" else 200)
    assert db_threads and all(thread != loop_thread for thread in db_threads)
    assert current_owner_id() is None


def test_command_poll_filters_other_devices_in_database(monkeypatch):
    engine = create_engine("sqlite://")
    Record.__table__.create(engine)
    with Session(engine) as db:
        commands = [
            {"id": "own", "deviceId": "device", "status": "queued"},
            {"id": "history", "deviceId": "device", "status": "succeeded"},
            {"id": "other", "deviceId": "other", "status": "queued"},
            {"id": "unassigned"}, {"id": "empty", "deviceId": ""},
            {"id": "null", "deviceId": None},
        ]
        for command in commands:
            db.add(Record(id=command["id"], kind="desktopCommands", owner_id="owner", data=command))
        db.add(Record(id="foreign", kind="desktopCommands", owner_id="foreign", data={"id": "foreign", "deviceId": "device"}))
        db.commit()
        original = service.normalize_timestamps

        def normalize(data):
            assert data["id"] not in {"other", "foreign"}, "unrelated payload was loaded into Python"
            return original(data)

        monkeypatch.setattr(service, "normalize_timestamps", normalize)
        with actor_scope(ActorContext(user_id="owner", role=ActorRole.MEMBER)):
            result = service.list_desktop_command_records(db, "device")
        assert {item["id"] for item in result} == {"own", "history", "unassigned", "empty", "null"}
