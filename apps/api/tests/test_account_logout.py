from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.auth import middleware
from app.auth.security import hash_secret
from app.config import get_settings
from app.database import Base, Record, get_db
from app.main import app
from app.models.auth import User, WebSession
from app.models.workflows import DesktopDevice
from app.repositories.workflow_records import sync_workflow_record


@pytest.fixture
def account_client(tmp_path, monkeypatch):
    monkeypatch.setenv("AUTH_TEST_BYPASS_USER_ID", "")
    get_settings.cache_clear()
    engine = create_engine(f"sqlite:///{tmp_path / 'accounts.sqlite'}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    sessions = sessionmaker(bind=engine)
    monkeypatch.setattr(middleware, "SessionLocal", sessions)

    def database():
        with sessions() as db:
            yield db

    app.dependency_overrides[get_db] = database
    with sessions() as db:
        for name in ("alice", "bob"):
            db.add(User(id=name, email=f"{name}@example.com", display_name=name, role="member", status="active"))
            db.flush()
            db.add(WebSession(id=f"session-{name}", user_id=name, token_hash=hash_secret(f"token-{name}"), expires_at=datetime.now(timezone.utc) + timedelta(days=1)))
        db.commit()
    client = TestClient(app)
    client.cookies.set("zhixin_session", "token-alice")
    yield client, sessions
    client.close()
    app.dependency_overrides.pop(get_db, None)
    engine.dispose()
    get_settings.cache_clear()


def device(client):
    response = client.post("/api/desktop-devices/register", json={"deviceName": "Test desktop"})
    assert response.status_code == 200
    return response.json()


def test_desktop_logout_revokes_session_and_device_but_preserves_history(account_client):
    client, sessions = account_client
    registered = device(client)
    device_id = registered["device"]["id"]
    response = client.post("/api/auth/logout", json={"desktopDeviceId": device_id})
    assert response.status_code == 204
    assert client.get("/api/auth/me").status_code == 401
    assert client.post(f"/api/desktop-devices/{device_id}/verify", json={"deviceToken": registered["deviceToken"]}).status_code == 403
    with sessions() as db:
        row = db.get(Record, device_id)
        assert row.owner_id == "alice"
        assert row.data["status"] == "signed_out"
        assert db.get(DesktopDevice, device_id).status == "signed_out"
        assert db.get(WebSession, "session-alice").revoked_at is not None
    client.cookies.set("zhixin_session", "token-alice")
    assert client.get("/api/auth/me").status_code == 401
    client.cookies.set("zhixin_session", "token-bob")
    assert device(client)["device"]["boundOwnerId"] == "bob"


def test_browser_logout_does_not_revoke_desktop(account_client):
    client, _ = account_client
    registered = device(client)
    assert client.post("/api/auth/logout").status_code == 204
    assert client.post(f"/api/desktop-devices/{registered['device']['id']}/verify", json={"deviceToken": registered["deviceToken"]}).status_code == 200


def test_logout_cannot_revoke_another_members_device(account_client):
    client, _ = account_client
    registered = device(client)
    client.cookies.set("zhixin_session", "token-bob")
    assert client.post("/api/auth/logout", json={"desktopDeviceId": registered["device"]["id"]}).status_code == 403
    assert client.get("/api/auth/me").json()["user"]["id"] == "bob"


@pytest.mark.parametrize("status", ["queued", "running"])
def test_pending_desktop_work_blocks_logout_without_revoking_session(account_client, status):
    client, sessions = account_client
    registered = device(client)
    device_id = registered["device"]["id"]
    with sessions() as db:
        data = {"id": "pending-command", "ownerId": "alice", "deviceId": device_id, "status": status, "type": "publish_article"}
        db.add(Record(id=data["id"], kind="desktopCommands", owner_id="alice", data=data))
        sync_workflow_record(db, "desktopCommands", data)
        db.commit()
    response = client.post("/api/auth/logout", json={"desktopDeviceId": device_id})
    assert response.status_code == 409
    assert response.json()["detail"] == "DESKTOP_WORK_IN_PROGRESS"
    assert client.get("/api/auth/me").status_code == 200


def test_expired_session_cannot_revoke_a_device(account_client):
    client, _ = account_client
    registered = device(client)
    client.cookies.clear()
    assert client.post("/api/auth/logout", json={"desktopDeviceId": registered["device"]["id"]}).status_code == 401


def test_logout_leaves_other_desktops_online_and_saved_content_untouched(account_client):
    client, sessions = account_client
    first, second = device(client), device(client)
    with sessions() as db:
        db.add(Record(id="saved-article", kind="articles", owner_id="alice", data={"title": "Keep this article"}))
        db.commit()
    assert client.post("/api/auth/logout", json={"desktopDeviceId": first["device"]["id"]}).status_code == 204
    assert client.post(f"/api/desktop-devices/{second['device']['id']}/verify", json={"deviceToken": second["deviceToken"]}).status_code == 200
    with sessions() as db:
        assert db.get(Record, "saved-article").data["title"] == "Keep this article"


@pytest.mark.parametrize("status", ["login_opened", "capturing", "verified", "submitted"])
def test_foreground_media_authorization_blocks_logout(account_client, status):
    client, sessions = account_client
    registered = device(client)
    device_id = registered["device"]["id"]
    with sessions() as db:
        db.add(Record(id="auth-session", kind="mediaAuthSessions", owner_id="alice", data={"deviceId": device_id, "status": status, "expiresAt": (datetime.now(timezone.utc) + timedelta(minutes=15)).isoformat()}))
        db.commit()
    response = client.post("/api/auth/logout", json={"desktopDeviceId": device_id})
    assert response.status_code == 409
    assert response.json()["detail"] == "DESKTOP_AUTH_IN_PROGRESS"
    assert client.get("/api/auth/me").status_code == 200


def test_abandoned_expired_media_authorization_does_not_trap_the_account(account_client):
    client, sessions = account_client
    registered = device(client)
    device_id = registered["device"]["id"]
    with sessions() as db:
        db.add(Record(id="abandoned-auth", kind="mediaAuthSessions", owner_id="alice", data={
            "deviceId": device_id, "status": "login_opened",
            "expiresAt": (datetime.now(timezone.utc) - timedelta(days=1)).isoformat(),
        }))
        db.commit()
    assert client.post("/api/auth/logout", json={"desktopDeviceId": device_id}).status_code == 204
    with sessions() as db:
        assert db.get(Record, "abandoned-auth").data["status"] == "expired"


@pytest.mark.parametrize("event_type", ["auth_failed", "auth_canceled"])
def test_foreground_authorization_terminal_event_releases_logout_immediately(account_client, event_type):
    client, _ = account_client
    registered = device(client)
    device_id = registered["device"]["id"]
    session = client.post("/api/media-auth-sessions", json={"platform": "zhihu", "deviceId": device_id}).json()["session"]
    headers = {"x-device-id": device_id, "x-device-token": registered["deviceToken"]}
    assert client.post(f"/api/desktop-devices/{device_id}/media-auth-sessions/{session['id']}/claim", headers=headers, json={"pairingCode": session["pairingCode"]}).status_code == 200
    assert client.post("/api/desktop-events", headers=headers, json={"deviceId": device_id, "sessionId": session["id"], "type": "browser_opened"}).status_code == 200
    assert client.post("/api/auth/logout", json={"desktopDeviceId": device_id}).status_code == 409
    assert client.post("/api/desktop-events", headers=headers, json={"deviceId": device_id, "sessionId": session["id"], "type": event_type}).status_code == 200
    assert client.post("/api/auth/logout", json={"desktopDeviceId": device_id}).status_code == 204


@pytest.mark.parametrize("logout_during_upload", [False, True])
def test_uploaded_artifact_blocks_logout_until_binding_even_after_old_login_lease(account_client, monkeypatch, logout_during_upload):
    client, sessions = account_client
    registered = device(client)
    device_id = registered["device"]["id"]
    session = client.post("/api/media-auth-sessions", json={"platform": "zhihu", "deviceId": device_id}).json()["session"]
    headers = {"x-device-id": device_id, "x-device-token": registered["deviceToken"]}
    assert client.post(f"/api/desktop-devices/{device_id}/media-auth-sessions/{session['id']}/claim", headers=headers, json={"pairingCode": session["pairingCode"]}).status_code == 200
    with sessions() as db:
        row = db.get(Record, session["id"])
        row.data = {**row.data, "expiresAt": (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()}
        db.commit()
    if logout_during_upload:
        import app.main as main_module
        from app.routes.auth import sign_out_desktop
        real_save = main_module.save_record

        def save_with_logout(db, kind, data):
            result = real_save(db, kind, data)
            if kind == "mediaAuthArtifacts":
                with sessions() as logout_db:
                    sign_out_desktop(logout_db, device_id, "alice")
                    logout_db.commit()
            return result

        monkeypatch.setattr(main_module, "save_record", save_with_logout)
    uploaded = client.post(f"/api/media-auth-sessions/{session['id']}/artifacts", headers=headers, json={
        "deviceId": device_id, "accountName": "Test account", "artifact": {
            "cookies": "encrypted-test-cookies", "authorizationEvidence": {
                "strongCookiePresent": True, "workspaceReady": True,
                "currentUrl": "https://www.zhihu.com/creator", "pageTitle": "Zhihu creator center",
            },
        },
    })
    if logout_during_upload:
        assert uploaded.status_code == 403
        with sessions() as db:
            assert db.get(Record, session["id"]).data["status"] == "expired"
            assert db.get(Record, device_id).data["status"] == "signed_out"
        return
    assert uploaded.status_code == 200
    assert uploaded.json()["session"]["status"] == "verified"
    assert client.post("/api/auth/logout", json={"desktopDeviceId": device_id}).status_code == 409
    client.cookies.clear()
    bound = client.post(f"/api/media-auth-sessions/{session['id']}/bind", headers=headers, json={"name": "Test account"})
    assert bound.status_code == 200
    assert bound.json()["session"]["status"] == "bound"
    client.cookies.set("zhixin_session", "token-alice")
    assert client.post("/api/auth/logout", json={"desktopDeviceId": device_id}).status_code == 204
