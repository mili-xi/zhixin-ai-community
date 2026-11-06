"""Remote transport, tenant isolation and durable video pipeline contracts."""
import hashlib
import json
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from app.auth.context import ActorContext, ActorRole, actor_scope
from app.auth.security import hash_secret
from app.auth.service import utc_now
from app.config import get_settings
from app.database import Base, Record, SessionLocal, engine
from app.main import app
from app.models.auth import User, WebSession
from app.service import save_record
from app import video_publishing as video


@pytest.fixture(scope="module")
def http():
    with TestClient(app) as client:
        yield client


@pytest.fixture(autouse=True)
def reset(tmp_path, monkeypatch):
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    monkeypatch.setenv("ZX_PRIVATE_VIDEO_DIR", str(tmp_path))
    monkeypatch.setattr(video, "validate_media", lambda *a: {"duration": 1, "width": 1280, "height": 720})
    with SessionLocal() as db:
        for owner in ("alice", "bob"):
            db.add(User(id=owner, email=f"{owner}@example.com", status="active", role="member"))
            db.add(WebSession(id=f"session-{owner}", user_id=owner, token_hash=hash_secret(owner), expires_at=utc_now()+timedelta(days=1)))
        db.commit()


def web(http, owner="alice"):
    http.cookies.clear()
    http.cookies.set(get_settings().auth_cookie_name, owner)


def credential(http, owner="alice", scopes=None):
    web(http, owner)
    r = http.post("/api/mcp/tokens", json={"name": "Test agent", "scopes": scopes or ["publish:read", "publish:write"], "expiresInDays": 30})
    assert r.status_code == 201, r.text
    http.cookies.clear()
    return r.json()


def auth(token):
    return {"Authorization": "Bearer "+token, "Accept": "application/json, text/event-stream"}


def rpc(http, token, method, params=None):
    r = http.post("/mcp", headers=auth(token), json={"jsonrpc": "2.0", "id": 1, "method": method, **({"params": params} if params is not None else {})})
    assert r.status_code == 200, r.text
    return r.json()


def call(http, token, name, arguments=None):
    result = rpc(http, token, "tools/call", {"name": name, "arguments": arguments or {}})
    assert "error" not in result, result
    result = result["result"]
    data = result.get("structuredContent") or json.loads(result["content"][0]["text"])
    return result, data


def seed(owner="alice"):
    with SessionLocal() as db, actor_scope(ActorContext(owner, ActorRole.MEMBER)):
        from app.app_time import now_stamp
        save_record(db, "desktopDevices", {"id": f"device-{owner}", "boundOwnerId": owner, "status": "active", "lastSeenAt": now_stamp(), "deviceTokenHash": hashlib.sha256(b"device-secret").hexdigest(), "capabilities": {"publish_video_v1": True, "publish_article_v1": True}})
        save_record(db, "mediaAuthArtifacts", {"id": f"auth-{owner}", "status": "active", "authorizationEvidence": {"strongCookiePresent": True, "workspaceReady": True}})
        save_record(db, "mediaAccounts", {"id": f"account-{owner}", "name": owner, "platform": "douyin", "status": "active", "credentialStatus": "active", "authArtifactId": f"auth-{owner}", "platformAccountId": owner, "cookies": "must-never-leak"})
        save_record(db, "mediaAccountBindings", {"id": f"binding-{owner}", "mediaAccountId": f"account-{owner}", "deviceId": f"device-{owner}", "status": "active"})


def upload(http, token):
    r = http.post("/api/mcp/video-assets/upload", headers=auth(token), files={"file": ("clip.mp4", b"mp4 fixture", "video/mp4")})
    assert r.status_code == 200, r.text
    assert "path" not in r.json()
    return r.json()["id"]


def test_token_requires_real_web_session_and_cannot_self_escalate(http):
    http.cookies.clear()
    assert http.post("/api/mcp/tokens", json={"name": "x"}).status_code == 401
    token = credential(http)["token"]
    assert http.get("/api/media-accounts", headers=auth(token)).status_code == 403
    assert http.post("/api/mcp/tokens", headers=auth(token), json={"name": "x"}).status_code == 403
    assert http.get("/api/mcp/tokens", headers=auth(token)).status_code == 403


def test_token_hash_only_list_revoke_and_owner_isolation(http):
    issued = credential(http)
    with SessionLocal() as db:
        assert issued["token"] not in json.dumps([row.data for row in db.query(Record).filter(Record.kind == "mcpTokens")])
    web(http, "bob")
    assert http.get("/api/mcp/tokens").json() == []
    assert http.delete("/api/mcp/tokens/"+issued["id"]).status_code == 404
    web(http)
    listed = http.get("/api/mcp/tokens").json()
    assert len(listed) == 1 and "token" not in listed[0] and "tokenHash" not in listed[0]
    assert http.delete("/api/mcp/tokens/"+issued["id"]).status_code == 204
    http.cookies.clear()
    assert http.post("/mcp", headers=auth(issued["token"]), json={}).status_code == 401


def test_initialize_tools_and_bearer_only_even_with_cookie_or_test_bypass(http):
    issued = credential(http)
    web(http)
    assert http.post("/mcp", json={}).status_code == 401
    http.cookies.clear()
    assert http.post("/mcp", headers=auth("invalid"), json={}).status_code == 401
    r = rpc(http, issued["token"], "initialize", {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "integration", "version": "1"}})
    assert r["result"]["serverInfo"]["name"] == "zhixin-ai"
    names = {t["name"] for t in rpc(http, issued["token"], "tools/list")["result"]["tools"]}
    assert {"get_publish_capabilities", "get_upload_instructions", "list_video_assets", "publish_video", "get_video_publication", "list_video_publications", "recheck_video_publication"} <= names


@pytest.mark.parametrize("change", ["expired", "disabled"])
def test_expired_or_disabled_user_is_rejected(http, change):
    issued = credential(http)
    with SessionLocal() as db:
        if change == "expired":
            row = db.get(Record, issued["id"])
            row.data = {**row.data, "expiresAt": (utc_now()-timedelta(seconds=1)).isoformat()}
        else:
            db.get(User, "alice").status = "disabled"
        db.commit()
    assert http.post("/mcp", headers=auth(issued["token"]), json={}).status_code == 401


def test_read_only_cannot_upload_or_publish(http):
    token = credential(http, scopes=["publish:read"])["token"]
    assert http.post("/api/mcp/video-assets/upload", headers=auth(token), files={"file": ("x.mp4", b"x")}).status_code == 403
    r, data = call(http, token, "publish_video", {"assetId": "a", "mediaAccountId": "b", "caption": "c", "idempotencyKey": "d", "confirmPublish": True})
    assert r.get("isError") is True and data["error"] == "MCP_SCOPE_REQUIRED"


def test_upload_instructions_and_tenant_lists_do_not_leak(http):
    seed(); seed("bob")
    alice = credential(http)["token"]
    bob = credential(http, "bob")["token"]
    _, instructions = call(http, alice, "get_upload_instructions")
    assert instructions["uploadPath"] == "/api/mcp/video-assets/upload"
    asset = upload(http, alice)
    for token, expected in [(alice, ["account-alice"]), (bob, ["account-bob"]), (alice, ["account-alice"])]:
        _, result = call(http, token, "get_publish_capabilities")
        assert [a["mediaAccountId"] for a in result["accounts"]] == expected
        assert "must-never-leak" not in json.dumps(result)
    _, result = call(http, bob, "list_video_assets")
    assert result["items"] == []
    r, result = call(http, bob, "publish_video", {"assetId": asset, "mediaAccountId": "account-bob", "caption": "x", "idempotencyKey": "b", "confirmPublish": True})
    assert r["isError"] and result["status"] == 404


def test_confirm_idempotency_and_durable_status_flow(http):
    seed()
    alice = credential(http)["token"]
    bob = credential(http, "bob")["token"]
    asset = upload(http, alice)
    args = {"assetId": asset, "mediaAccountId": "account-alice", "caption": "Test video", "idempotencyKey": "one", "confirmPublish": False}
    result, data = call(http, alice, "publish_video", args)
    assert result["isError"] and data["error"] == "PUBLISH_CONFIRMATION_REQUIRED"
    args["confirmPublish"] = True
    _, first = call(http, alice, "publish_video", args)
    _, again = call(http, alice, "publish_video", args)
    assert again["deduplicated"] and again["publication"]["commandId"] == first["publication"]["commandId"]
    pub = first["publication"]
    r, data = call(http, bob, "get_video_publication", {"publicationId": pub["id"]})
    assert r["isError"] and data["status"] == 404
    command = pub["commandId"]
    headers = {"x-device-id": "device-alice", "x-device-token": "device-secret"}
    for kind, payload in [("publish_progress", {"stage": "submitting"}), ("publish_succeeded", {"itemId": "123456", "submissionAccepted": True})]:
        response = http.post(f"/api/desktop-commands/{command}/events", headers=headers, json={"type": kind, "payload": payload})
        assert response.status_code == 200, response.text
    _, status = call(http, alice, "get_video_publication", {"publicationId": pub["id"]})
    assert status["status"] == "submitted_for_review" and not status.get("publicUrl")
    _, discovery = call(http, alice, "recheck_video_publication", {"publicationId": pub["id"]})
    assert discovery["publication"]["id"] == pub["id"]
    with SessionLocal() as db, actor_scope(ActorContext("alice", ActorRole.MEMBER)):
        from app.service import get_record
        discovery_id = get_record(db, "videoPublications", pub["id"])["discoveryCommandId"]
    response = http.post(f"/api/desktop-commands/{discovery_id}/events", headers=headers, json={"type": "publication_discovery_succeeded", "payload": {"itemId": "123456", "platformStatus": "published", "found": True, "publicUrl": "https://www.douyin.com/video/123456", "publicationEvidence": {"workListVerified": True, "detailVerified": True}}})
    assert response.status_code == 200, response.text
    _, public = call(http, alice, "get_video_publication", {"publicationId": pub["id"]})
    assert public["status"] == "published" and public["publicUrl"] == "https://www.douyin.com/video/123456"
    _, other = call(http, bob, "list_video_publications")
    assert other["items"] == []


def test_upload_bearer_not_accepted_as_regular_web_upload_and_origin_is_checked(http):
    token = credential(http)["token"]
    assert http.post("/api/video-assets/upload", headers=auth(token), files={"file": ("x.mp4", b"x")}).status_code == 403
    assert http.post("/mcp", headers={**auth(token), "Origin": "https://untrusted.example"}, json={}).status_code == 403


def test_token_creation_rejects_unsupported_permissions(http):
    web(http)
    assert http.post("/api/mcp/tokens", json={"name": "bad", "scopes": ["admin"]}).status_code == 422
    assert http.post("/api/mcp/tokens", json={"name": "bad", "scopes": ["publish:write"]}).status_code == 422


def test_upload_authentication_runs_before_multipart_parser(http):
    # Bad multipart would be 400/422 if parsing were allowed before auth.
    http.cookies.clear()
    r = http.post("/api/mcp/video-assets/upload", headers={"content-type": "multipart/form-data; boundary=bad"}, content=b"not multipart")
    assert r.status_code == 401


def test_protocol_request_size_is_bounded(http):
    token = credential(http)["token"]
    assert http.post("/mcp", headers=auth(token), content=b"x"*(128*1024+1)).status_code == 413


def test_pagination_and_input_validation(http):
    token = credential(http)["token"]
    with SessionLocal() as db, actor_scope(ActorContext("alice", ActorRole.MEMBER)):
        for index in range(3):
            save_record(db, "videoAssets", {"id": f"asset-{index}", "kind": "video", "filename": f"{index}.mp4", "path": "private path must not leak"})
    _, first = call(http, token, "list_video_assets", {"limit": 2})
    _, second = call(http, token, "list_video_assets", {"limit": 2, "offset": first["nextOffset"]})
    assert len(first["items"]) == 2 and len(second["items"]) == 1 and second["nextOffset"] is None
    assert not any("path" in a for a in first["items"]+second["items"])
    result = rpc(http, token, "tools/call", {"name": "list_video_assets", "arguments": {"limit": 1000000}})
    assert result["result"]["isError"] is True


def test_unknown_submission_replay_never_reposts(http):
    seed()
    token = credential(http)["token"]
    asset = upload(http, token)
    args = {"assetId": asset, "mediaAccountId": "account-alice", "caption": "Unknown outcome", "idempotencyKey": "first", "confirmPublish": True}
    _, first = call(http, token, "publish_video", args)
    pub = first["publication"]
    for kind, payload in [("publish_progress", {"stage": "submitting"}), ("publish_failed", {"errorMessage": "connection lost"})]:
        assert http.post(f"/api/desktop-commands/{pub['commandId']}/events", headers={"x-device-id": "device-alice", "x-device-token": "device-secret"}, json={"type": kind, "payload": payload}).status_code == 200
    _, again = call(http, token, "publish_video", {**args, "idempotencyKey": "changed-key"})
    assert again["deduplicated"] and again["publication"]["status"] == "submission_unknown"
    assert again["publication"]["commandId"] == pub["commandId"]


def test_parallel_calls_keep_tenant_contexts_separate(http):
    from concurrent.futures import ThreadPoolExecutor
    seed(); seed("bob")
    alice = credential(http)["token"]
    bob = credential(http, "bob")["token"]
    requests = [(alice, "account-alice"), (bob, "account-bob")]*4
    def check(pair):
        token, account = pair
        _, result = call(http, token, "get_publish_capabilities")
        return [r["mediaAccountId"] for r in result["accounts"]] == [account]
    with ThreadPoolExecutor(max_workers=4) as pool:
        assert all(pool.map(check, requests))


def test_slow_tool_does_not_block_other_users_or_heartbeats(http, monkeypatch):
    import threading
    import time
    from concurrent.futures import ThreadPoolExecutor
    started = threading.Event()
    def slow(*args):
        started.set()
        time.sleep(0.8)  # Model a DB row lock held by a concurrent transaction.
        return {"accounts": []}
    monkeypatch.setattr(video, "video_capabilities", slow)
    token = credential(http)["token"]
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(call, http, token, "get_publish_capabilities")
        assert started.wait(3)
        before = time.monotonic()
        assert http.get("/health").status_code == 200
        elapsed = time.monotonic()-before
        pending.result(timeout=5)
    assert elapsed < 0.4, f"Shared API loop was blocked for {elapsed:.2f}s"


def test_active_token_stays_visible_after_large_revoked_history(http):
    issued = credential(http)
    with SessionLocal() as db:
        for index in range(101):
            db.add(Record(id=f"old-token-{index}", kind="mcpTokens", owner_id="alice", created_at=utc_now()+timedelta(seconds=index+1), data={"id": f"old-token-{index}", "name": "Revoked", "scopes": ["publish:read"], "createdAt": utc_now().isoformat(), "expiresAt": (utc_now()+timedelta(days=1)).isoformat(), "revokedAt": utc_now().isoformat()}))
        db.commit()
    web(http)
    assert issued["id"] in [r["id"] for r in http.get("/api/mcp/tokens").json()]


def test_slow_post_parse_upload_auth_does_not_block_api(http, monkeypatch):
    import threading
    import time
    from concurrent.futures import ThreadPoolExecutor
    from app import mcp_access, mcp_server
    original = mcp_access.resolve_agent
    started = threading.Event()
    count = 0
    def slow(*args, **kwargs):
        nonlocal count
        count += 1
        if count == 2:
            started.set()
            time.sleep(0.8)
        return original(*args, **kwargs)
    monkeypatch.setattr(mcp_access, "resolve_agent", slow)
    monkeypatch.setattr(mcp_server, "resolve_agent", slow)
    token = credential(http)["token"]
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(upload, http, token)
        assert started.wait(3)
        before = time.monotonic()
        assert http.get("/health").status_code == 200
        elapsed = time.monotonic()-before
        pending.result(timeout=5)
    assert elapsed < 0.4, f"Upload revalidation blocked API for {elapsed:.2f}s"
