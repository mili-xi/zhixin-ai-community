from fastapi.testclient import TestClient
from app.main import app
from app.database import Base, engine, SessionLocal
from app.service import save_record, list_canonical_media_accounts, supersede_duplicate_media_accounts, media_account_slot_key


def setup_function():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)


def bind(uid, suffix, target=""):
    with SessionLocal() as db:
        save_record(db, "mediaAuthArtifacts", {"id": "a"+suffix, "platform": "douyin", "platformConfig": {"accountId": uid}})
        save_record(db, "mediaAuthSessions", {"id": "s"+suffix, "platform": "douyin", "status": "verified", "artifactId": "a"+suffix, "mediaAccountId": target})
    return TestClient(app).post("/api/media-auth-sessions/s"+suffix+"/bind", json={})


def test_distinct_logins_and_same_uid_reauthorization():
    a = bind("uid1", "1")
    b = bind("uid2", "2")
    assert a.status_code == b.status_code == 200
    aid = a.json()["mediaAccount"]["id"]
    bid = b.json()["mediaAccount"]["id"]
    assert aid != bid
    assert bind("uid1", "3").json()["mediaAccount"]["id"] == aid
    with SessionLocal() as db:
        supersede_duplicate_media_accounts(db)
        accounts = list_canonical_media_accounts(db)
        assert {a["id"] for a in accounts} == {aid, bid}
        assert all(a["status"] == "active" for a in accounts)


def test_reauthorization_mismatch_and_missing_identity():
    aid = bind("uid1", "1").json()["mediaAccount"]["id"]
    assert bind("uid2", "2", aid).status_code == 409
    assert bind("", "3").status_code == 400
    with SessionLocal() as db:
        accounts = list_canonical_media_accounts(db)
        assert len(accounts) == 1
        assert accounts[0]["platformConfig"]["accountId"] == "uid1"
        assert accounts[0]["authArtifactId"] == "a1"


def test_owner_and_legacy_slots_are_separate():
    a = {"id": "a", "ownerId": "one", "platform": "douyin", "platformConfig": {"accountId": "uid"}}
    assert media_account_slot_key(a) != media_account_slot_key({**a, "ownerId": "two"})
    assert media_account_slot_key({**a, "platformConfig": {}}) != media_account_slot_key({**a, "id": "b", "platformConfig": {}})


def test_missing_explicit_target_fails_closed():
    bind("uid1", "1")
    assert bind("uid1", "2", "nonexistent").status_code == 404


def test_refresh_mismatch_route_preserves_both_accounts():
    from app.service import get_record, list_records
    client = TestClient(app)
    device = client.post("/api/desktop-devices/register", json={"deviceName": "test"}).json()
    a = bind("uid1", "1").json()["mediaAccount"]
    b = bind("uid2", "2").json()["mediaAccount"]
    with SessionLocal() as db:
        before = {kind: list_records(db, kind) for kind in ("mediaAccounts", "mediaAccountBindings", "mediaAuthArtifacts")}
    response = client.post(f"/api/desktop-devices/{device['device']['id']}/media-accounts/{a['id']}/artifacts/refresh", json={"deviceToken": device["deviceToken"], "artifact": {"cookies": "encrypted", "platformConfig": {"accountId": "uid2"}}})
    assert response.status_code == 409
    with SessionLocal() as db:
        assert before == {kind: list_records(db, kind) for kind in before}


def test_expiry_and_deletion_preserve_other_account():
    from app.service import get_record, list_records, patch_record
    a = bind("uid1", "1").json()["mediaAccount"]
    b = bind("uid2", "2").json()["mediaAccount"]
    with SessionLocal() as db:
        before = {kind: [x for x in list_records(db, kind) if x.get("mediaAccountId") == b["id"] or x.get("id") == b["id"]] for kind in ("mediaAccounts", "mediaAccountBindings", "mediaAuthArtifacts")}
        patch_record(db, "mediaAccounts", a["id"], {"status": "expired", "credentialStatus": "expired"})
    assert TestClient(app).delete("/api/media-accounts/"+a["id"]).status_code == 200
    with SessionLocal() as db:
        assert before == {kind: [x for x in list_records(db, kind) if x.get("mediaAccountId") == b["id"] or x.get("id") == b["id"]] for kind in before}


def test_cross_owner_bind_and_list_isolation():
    from app.auth.context import ActorContext, ActorRole, actor_scope
    from test_owner_isolation import login
    clients = [login("multi-a@example.com"), login("multi-b@example.com")]
    ids = []
    for n, client in enumerate(clients):
        owner = client.get("/api/auth/me").json()["user"]["id"]
        with actor_scope(ActorContext(user_id=owner, role=ActorRole.MEMBER)), SessionLocal() as db:
            save_record(db, "mediaAuthArtifacts", {"id": f"oa{n}", "platform": "douyin", "platformConfig": {"accountId": "same-uid"}})
            save_record(db, "mediaAuthSessions", {"id": f"os{n}", "platform": "douyin", "status": "verified", "artifactId": f"oa{n}"})
        response = client.post(f"/api/media-auth-sessions/os{n}/bind", json={})
        assert response.status_code == 200
        ids.append(response.json()["mediaAccount"]["id"])
    assert ids[0] != ids[1]
    for n, client in enumerate(clients):
        assert [x["id"] for x in client.get("/api/media-accounts").json()] == [ids[n]]
        assert client.post(f"/api/media-auth-sessions/os{1-n}/bind", json={}).status_code == 404
