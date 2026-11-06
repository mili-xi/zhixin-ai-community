import os
from pathlib import Path

os.environ["DATABASE_URL"] = f"sqlite:///{Path(__file__).parent / 'test.sqlite'}"
os.environ["AUTH_DEBUG_RETURN_CODE"] = "true"
os.environ["AUTH_REGISTRATION_ENABLED"] = "true"

from fastapi.testclient import TestClient
from fastapi import Response

from app.database import Base, engine
from app.main import app
from app.config import Settings
from app.routes.auth import _set_session_cookie


client = TestClient(app)


def setup_function() -> None:
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    client.cookies.clear()


def request_registration_code(email: str) -> str:
    response = client.post("/api/auth/register/request-code", json={"email": email})
    assert response.status_code == 202
    return response.json()["debugCode"]


def register(email: str, password: str = "CorrectHorse123") -> dict:
    code = request_registration_code(email)
    response = client.post(
        "/api/auth/register",
        json={
            "email": email,
            "code": code,
            "password": password,
            "displayName": "Internal member",
        },
    )
    assert response.status_code == 201
    return {**response.json(), "setCookie": response.headers.get("set-cookie", "")}


def test_user_verifies_email_once_then_logs_in_with_password() -> None:
    registered = register("Member-A@Example.com")

    assert registered["user"]["email"] == "member-a@example.com"
    assert registered["user"]["displayName"] == "Internal member"
    assert "zhixin_session=" in registered["setCookie"]

    client.cookies.clear()
    logged_in = client.post(
        "/api/auth/login",
        json={"email": "member-a@example.com", "password": "CorrectHorse123"},
    )

    assert logged_in.status_code == 200
    assert logged_in.json()["user"]["email"] == "member-a@example.com"
    assert client.get("/api/auth/me").status_code == 200


def test_session_cookie_supports_secure_embedded_desktop_login() -> None:
    response = Response()
    settings = Settings(auth_cookie_secure=True, auth_cookie_samesite="none")

    _set_session_cookie(response, settings, "session-token")

    set_cookie = response.headers["set-cookie"]
    assert "SameSite=none" in set_cookie
    assert "Secure" in set_cookie


def test_registration_requires_a_valid_single_use_code() -> None:
    code = request_registration_code("member-b@example.com")

    wrong = client.post(
        "/api/auth/register",
        json={"email": "member-b@example.com", "code": "000000", "password": "CorrectHorse123"},
    )
    assert wrong.status_code == 401

    created = client.post(
        "/api/auth/register",
        json={"email": "member-b@example.com", "code": code, "password": "CorrectHorse123"},
    )
    assert created.status_code == 201

    reused = client.post(
        "/api/auth/register",
        json={"email": "member-b@example.com", "code": code, "password": "AnotherPassword123"},
    )
    assert reused.status_code in {401, 409}


def test_registered_email_cannot_register_twice() -> None:
    register("member-a@example.com")
    client.cookies.clear()

    duplicate = client.post(
        "/api/auth/register/request-code",
        json={"email": "member-a@example.com"},
    )

    assert duplicate.status_code == 409
    assert duplicate.json()["detail"] == "EMAIL_ALREADY_REGISTERED"


def test_wrong_password_does_not_create_a_session() -> None:
    register("member-a@example.com")
    client.cookies.clear()

    response = client.post(
        "/api/auth/login",
        json={"email": "member-a@example.com", "password": "WrongPassword123"},
    )

    assert response.status_code == 401
    assert response.json()["detail"] == "INVALID_EMAIL_OR_PASSWORD"
    assert client.get("/api/auth/me").status_code == 401

def test_each_registered_member_receives_owner_scoped_writer_defaults() -> None:
    first = register("member-a@example.com")
    first_types = client.get("/api/article-types")
    first_rules = client.get("/api/generation-rules")

    assert first_types.status_code == 200
    assert first_rules.status_code == 200
    assert first_types.json()
    assert first_rules.json()
    assert {item["ownerId"] for item in first_types.json()} == {first["user"]["id"]}
    assert {item["ownerId"] for item in first_rules.json()} == {first["user"]["id"]}

    client.cookies.clear()
    second = register("member-b@example.com")
    second_types = client.get("/api/article-types")
    second_rules = client.get("/api/generation-rules")

    assert second_types.status_code == 200
    assert second_rules.status_code == 200
    assert second_types.json()
    assert second_rules.json()
    assert {item["ownerId"] for item in second_types.json()} == {second["user"]["id"]}
    assert {item["ownerId"] for item in second_rules.json()} == {second["user"]["id"]}



def test_logout_revokes_password_session() -> None:
    register("member-a@example.com")

    logged_out = client.post("/api/auth/logout")

    assert logged_out.status_code == 204
    assert client.get("/api/auth/me").status_code == 401


def test_registration_delivery_failure_returns_service_unavailable(monkeypatch) -> None:
    import app.routes.auth as auth_routes
    from app.auth.email_delivery import EmailDeliveryError

    def fail_delivery(*args, **kwargs):
        raise EmailDeliveryError("AUTH_EMAIL_DELIVERY_FAILED")

    monkeypatch.setattr(auth_routes, "deliver_registration_code", fail_delivery, raising=False)
    response = client.post(
        "/api/auth/register/request-code",
        json={"email": "member-a@example.com"},
    )

    assert response.status_code == 503
    assert response.json()["detail"] == "AUTH_EMAIL_DELIVERY_FAILED"
