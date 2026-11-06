from __future__ import annotations

from fastapi.testclient import TestClient

from app.database import Base, engine
from app.main import app


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

def setup_function() -> None:
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)


def test_members_only_see_and_open_their_own_articles() -> None:
    member_a = login("member-a@example.com")
    member_b = login("member-b@example.com")

    article_a = member_a.post("/api/articles", json={"title": "Member A article"}).json()
    article_b = member_b.post("/api/articles", json={"title": "Member B article"}).json()

    assert [item["id"] for item in member_a.get("/api/articles").json()] == [article_a["id"]]
    assert [item["id"] for item in member_b.get("/api/articles").json()] == [article_b["id"]]
    assert member_a.get(f"/api/articles/{article_b['id']}").status_code == 404
    assert member_b.get(f"/api/articles/{article_a['id']}").status_code == 404


def test_frontend_cannot_spoof_record_owner() -> None:
    member_a = login("member-a@example.com")
    member_b = login("member-b@example.com")
    member_b_id = member_b.get("/api/auth/me").json()["user"]["id"]

    created = member_a.post(
        "/api/articles",
        json={"title": "Spoof attempt", "ownerId": member_b_id},
    )

    assert created.status_code == 200
    assert created.json()["ownerId"] != member_b_id
    assert [item["id"] for item in member_b.get("/api/articles").json()] == []
