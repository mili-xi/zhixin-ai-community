from __future__ import annotations

from fastapi.testclient import TestClient

from app.database import Base, Record, SessionLocal, engine
from app.main import app
from app.models.workflows import DesktopDevice


def login(email: str) -> TestClient:
    client = TestClient(app)
    requested = client.post("/api/auth/register/request-code", json={"email": email})
    assert requested.status_code == 202
    registered = client.post(
        "/api/auth/register",
        json={
            "email": email,
            "code": requested.json()["debugCode"],
            "password": "CorrectHorse123",
        },
    )
    assert registered.status_code == 201
    return client

def register_unbound_device() -> dict:
    agent = TestClient(app)
    registered = agent.post(
        "/api/desktop-devices/register",
        json={"deviceName": "Internal desktop", "platform": "windows", "appVersion": "0.2.0"},
    )
    assert registered.status_code == 200
    result = registered.json()
    device_id = result["device"]["id"]

    # The global test bypass represents an authenticated browser request. Reset
    # this fixture to the production state where a CLI registration is unbound.
    with SessionLocal() as db:
        record = db.get(Record, device_id)
        assert record is not None
        data = dict(record.data)
        data.pop("boundOwnerId", None)
        data["ownerId"] = "legacy-internal-owner"
        record.owner_id = "legacy-internal-owner"
        record.data = data
        workflow = db.get(DesktopDevice, device_id)
        assert workflow is not None
        workflow.owner_id = "legacy-internal-owner"
        workflow.data = data
        db.commit()

    return result


def claim_headers(device: dict) -> dict[str, str]:
    return {
        "x-device-id": device["device"]["id"],
        "x-device-token": device["deviceToken"],
    }


def setup_function() -> None:
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)


def test_member_can_bind_an_unbound_desktop_device_once() -> None:
    member_a = login("member-a@example.com")
    member_b = login("member-b@example.com")
    device = register_unbound_device()

    created = member_a.post("/api/desktop-owner-bindings")
    assert created.status_code == 201
    binding = created.json()

    claimed = TestClient(app).post(
        f"/api/desktop-devices/{device['device']['id']}/owner-bindings/{binding['id']}/claim",
        headers=claim_headers(device),
        json={"pairingCode": binding["pairingCode"]},
    )

    assert claimed.status_code == 200
    assert claimed.json()["device"]["boundOwnerId"] == member_a.get("/api/auth/me").json()["user"]["id"]
    assert [item["id"] for item in member_a.get("/api/desktop-devices").json()] == [device["device"]["id"]]
    assert member_b.get("/api/desktop-devices").json() == []


def test_bound_device_cannot_be_silently_reassigned_to_another_member() -> None:
    member_a = login("member-a@example.com")
    member_b = login("member-b@example.com")
    device = register_unbound_device()

    binding_a = member_a.post("/api/desktop-owner-bindings").json()
    first_claim = TestClient(app).post(
        f"/api/desktop-devices/{device['device']['id']}/owner-bindings/{binding_a['id']}/claim",
        headers=claim_headers(device),
        json={"pairingCode": binding_a["pairingCode"]},
    )
    assert first_claim.status_code == 200

    binding_b = member_b.post("/api/desktop-owner-bindings").json()
    second_claim = TestClient(app).post(
        f"/api/desktop-devices/{device['device']['id']}/owner-bindings/{binding_b['id']}/claim",
        headers=claim_headers(device),
        json={"pairingCode": binding_b["pairingCode"]},
    )

    assert second_claim.status_code == 409
    assert second_claim.json()["detail"] == "DESKTOP_DEVICE_ALREADY_BOUND"


def test_bound_desktop_only_polls_its_members_commands() -> None:
    member_a = login("member-a@example.com")
    member_b = login("member-b@example.com")
    device = register_unbound_device()
    binding = member_a.post("/api/desktop-owner-bindings").json()
    claimed = TestClient(app).post(
        f"/api/desktop-devices/{device['device']['id']}/owner-bindings/{binding['id']}/claim",
        headers=claim_headers(device),
        json={"pairingCode": binding["pairingCode"]},
    )
    assert claimed.status_code == 200

    own_command = member_a.post(
        "/api/desktop-commands",
        json={"type": "open_auth", "deviceId": device["device"]["id"], "payload": {}},
    )
    assert own_command.status_code == 200
    foreign_command = member_b.post(
        "/api/desktop-commands",
        json={"type": "open_auth", "payload": {}},
    )
    assert foreign_command.status_code == 200

    polled = TestClient(app).get("/api/desktop-commands", headers=claim_headers(device))

    assert polled.status_code == 200
    assert [item["id"] for item in polled.json()] == [own_command.json()["id"]]
    assert foreign_command.json()["id"] not in {item["id"] for item in polled.json()}


def test_desktop_event_requires_a_valid_device_credential() -> None:
    response = TestClient(app).post(
        "/api/desktop-events",
        json={"deviceId": "missing-device", "type": "heartbeat", "payload": {}},
    )

    assert response.status_code == 403
    assert response.json()["detail"] == "DESKTOP_DEVICE_AUTH_REQUIRED"


def test_open_auth_command_cannot_target_a_device_bound_to_another_member() -> None:
    member_a = login("member-a@example.com")
    member_b = login("member-b@example.com")
    device = register_unbound_device()
    binding = member_a.post("/api/desktop-owner-bindings").json()
    claimed = TestClient(app).post(
        f"/api/desktop-devices/{device['device']['id']}/owner-bindings/{binding['id']}/claim",
        headers=claim_headers(device),
        json={"pairingCode": binding["pairingCode"]},
    )
    assert claimed.status_code == 200
    assert claimed.json()["device"]["boundOwnerId"] == member_a.get("/api/auth/me").json()["user"]["id"]

    foreign_command = member_b.post(
        "/api/desktop-commands",
        json={"type": "open_auth", "deviceId": device["device"]["id"], "payload": {}},
    )
    assert foreign_command.status_code == 403
    assert foreign_command.json()["detail"] == "DESKTOP_DEVICE_OWNER_MISMATCH"

    foreign_session = member_b.post(
        "/api/media-auth-sessions",
        json={"platform": "zhihu", "deviceId": device["device"]["id"], "queueDesktopCommand": True},
    )
    assert foreign_session.status_code == 403
    assert foreign_session.json()["detail"] == "DESKTOP_DEVICE_OWNER_MISMATCH"

    polled = TestClient(app).get("/api/desktop-commands", headers=claim_headers(device))
    assert polled.status_code == 200
    assert polled.json() == []

    own_command = member_a.post(
        "/api/desktop-commands",
        json={"type": "open_auth", "deviceId": device["device"]["id"], "payload": {}},
    )
    assert own_command.status_code == 200
    own_session = member_a.post(
        "/api/media-auth-sessions",
        json={"platform": "zhihu", "deviceId": device["device"]["id"], "queueDesktopCommand": True},
    )
    assert own_session.status_code == 200
    assert own_session.json()["desktopCommand"]["deviceId"] == device["device"]["id"]


def test_web_actor_cannot_replace_desktop_agent_credentials() -> None:
    member = login("member-a@example.com")
    device = register_unbound_device()
    binding = member.post("/api/desktop-owner-bindings").json()
    claimed_owner = TestClient(app).post(
        f"/api/desktop-devices/{device['device']['id']}/owner-bindings/{binding['id']}/claim",
        headers=claim_headers(device),
        json={"pairingCode": binding["pairingCode"]},
    )
    assert claimed_owner.status_code == 200

    session = member.post(
        "/api/media-auth-sessions",
        json={"platform": "zhihu", "deviceId": device["device"]["id"]},
    ).json()["session"]
    missing_claim_token = member.post(
        f"/api/desktop-devices/{device['device']['id']}/media-auth-sessions/{session['id']}/claim",
        json={"pairingCode": session["pairingCode"]},
    )
    assert missing_claim_token.status_code == 403

    claimed_session = TestClient(app).post(
        f"/api/desktop-devices/{device['device']['id']}/media-auth-sessions/{session['id']}/claim",
        headers=claim_headers(device),
        json={"pairingCode": session["pairingCode"]},
    )
    assert claimed_session.status_code == 200

    command = member.post(
        "/api/desktop-commands",
        json={"type": "open_auth", "deviceId": device["device"]["id"], "payload": {}},
    ).json()
    missing_event_token = member.post(
        f"/api/desktop-commands/{command['id']}/events",
        json={"deviceId": device["device"]["id"], "type": "running"},
    )
    assert missing_event_token.status_code == 403

    header_authenticated_event = TestClient(app).post(
        f"/api/desktop-commands/{command['id']}/events",
        headers=claim_headers(device),
        json={"type": "running"},
    )
