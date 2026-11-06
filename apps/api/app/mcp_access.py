"""Scoped personal access credentials for remote agents; never platform cookies."""
from __future__ import annotations

import hashlib
import hmac
import re
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import select, func, case
from sqlalchemy.orm import Session

from .auth.context import ActorContext, ActorRole
from .auth.service import resolve_web_session, utc_now
from .config import csv_setting, get_settings
from .database import Record, get_db
from .models.auth import User

router = APIRouter(prefix="/api/mcp", tags=["agent-access"])
READ = "publish:read"
WRITE = "publish:write"
ARTICLE_WRITE = "article:write"
UPLOAD_PATH = "/api/mcp/video-assets/upload"
ARTICLE_UPLOAD_PATH = "/api/mcp/article-assets/upload"
MCP_UPLOAD_SCOPES = {UPLOAD_PATH: WRITE, ARTICLE_UPLOAD_PATH: ARTICLE_WRITE}
MCP_PATHS = {"/mcp", "/mcp/"}
TOKEN_RE = re.compile(r"zx_mcp_([a-f0-9]{32})\.([A-Za-z0-9_-]{43})\Z")
PUBLIC_FIELDS = ("id", "name", "scopes", "createdAt", "expiresAt", "revokedAt")


@dataclass(frozen=True)
class AgentIdentity:
    actor: ActorContext
    scopes: frozenset[str]
    token_id: str

    def require(self, scope: str) -> None:
        if scope not in self.scopes:
            raise HTTPException(403, "MCP_SCOPE_REQUIRED")


def check_origin(request: Request) -> None:
    origin = request.headers.get("origin")
    if origin is not None and origin not in csv_setting(get_settings().auth_allowed_origins):
        raise HTTPException(403, "MCP_ORIGIN_NOT_ALLOWED")


def _web_user(request: Request, db: Session) -> User:
    # Require an actual web session, not a desktop actor or a test bypass.
    if request.headers.get("authorization"):
        raise HTTPException(403, "MCP_WEB_SESSION_REQUIRED")
    check_origin(request)
    resolved = resolve_web_session(db, request.cookies.get(get_settings().auth_cookie_name, ""))
    if resolved is None:
        raise HTTPException(401, "AUTHENTICATION_REQUIRED")
    return resolved[0]


def resolve_agent(request: Request, db: Session, required_scope: str | None = None) -> AgentIdentity:
    check_origin(request)
    scheme, _, raw_token = request.headers.get("authorization", "").partition(" ")
    match = TOKEN_RE.fullmatch(raw_token) if scheme.lower() == "bearer" else None
    invalid = HTTPException(401, "MCP_INVALID_TOKEN", headers={"WWW-Authenticate": 'Bearer realm="zhixin-ai-mcp"'})
    if not match:
        raise invalid
    row = db.get(Record, "mcp-token-"+match[1])
    if row is None or row.kind != "mcpTokens":
        raise invalid
    data = row.data
    if not hmac.compare_digest(hashlib.sha256(raw_token.encode()).hexdigest(), str(data.get("tokenHash") or "")):
        raise invalid
    try:
        expires = datetime.fromisoformat(data["expiresAt"])
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=timezone.utc)
    except (KeyError, TypeError, ValueError):
        raise invalid from None
    if data.get("revokedAt") or expires <= utc_now():
        raise invalid
    user = db.get(User, row.owner_id)
    if user is None or user.status != "active":
        raise invalid
    identity = AgentIdentity(ActorContext(user.id, ActorRole.MEMBER), frozenset(data.get("scopes") or []), row.id)
    if required_scope:
        identity.require(required_scope)
    return identity


def authenticate_request(request: Request, required_scope: str = READ) -> AgentIdentity:
    # Own the entire short-lived session in the worker thread that uses it.
    from .database import SessionLocal
    with SessionLocal() as db:
        return resolve_agent(request, db, required_scope)


class CreateToken(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=80)
    scopes: list[Literal["publish:read", "publish:write", "article:write"]] = Field(default_factory=lambda: [READ])
    expiresInDays: int = Field(default=30, ge=1, le=365, strict=True)

    @model_validator(mode="after")
    def valid_scopes(self):
        self.name = self.name.strip()
        if not self.name or READ not in self.scopes or len(set(self.scopes)) != len(self.scopes):
            raise ValueError("A name and publish:read are required; scopes must be unique")
        return self


@router.post("/tokens", status_code=201)
def create_token(body: CreateToken, request: Request, response: Response, db: Session = Depends(get_db)) -> dict:
    user = _web_user(request, db)
    # Serializes concurrent issuance for this user in PostgreSQL.
    db.scalar(select(User).where(User.id == user.id).with_for_update())
    now = utc_now()
    active = db.scalar(select(func.count()).select_from(Record).where(Record.kind == "mcpTokens", Record.owner_id == user.id, Record.data["revokedAt"].as_string() == "", Record.data["expiresAt"].as_string() > now.isoformat()))
    if active >= 20:
        raise HTTPException(409, "MCP_TOKEN_LIMIT_REACHED")
    suffix = uuid4().hex
    token = f"zx_mcp_{suffix}.{secrets.token_urlsafe(32)}"
    record = {"id": "mcp-token-"+suffix, "name": body.name, "scopes": body.scopes, "createdAt": now.isoformat(), "expiresAt": (now+timedelta(days=body.expiresInDays)).isoformat(), "revokedAt": "", "tokenHash": hashlib.sha256(token.encode()).hexdigest()}
    db.add(Record(id=record["id"], kind="mcpTokens", owner_id=user.id, data=record))
    db.commit()
    response.headers["Cache-Control"] = "no-store"
    return {**{k: record[k] for k in PUBLIC_FIELDS}, "token": token}


@router.get("/tokens")
def list_tokens(request: Request, response: Response, db: Session = Depends(get_db)) -> list[dict]:
    user = _web_user(request, db)
    active = (Record.data["revokedAt"].as_string() == "") & (Record.data["expiresAt"].as_string() > utc_now().isoformat())
    # All active credentials (capped at 20 on issuance) must remain discoverable
    # for revocation even after hundreds of short-lived historical credentials.
    rows = db.scalars(select(Record).where(Record.kind == "mcpTokens", Record.owner_id == user.id).order_by(case((active, 0), else_=1), Record.created_at.desc(), Record.id.desc()).limit(100)).all()
    response.headers["Cache-Control"] = "no-store"
    return [{k: row.data.get(k) for k in PUBLIC_FIELDS} for row in rows]


@router.delete("/tokens/{token_id}", status_code=204)
def revoke_token(token_id: str, request: Request, db: Session = Depends(get_db)) -> Response:
    user = _web_user(request, db)
    row = db.scalar(select(Record).where(Record.id == token_id, Record.kind == "mcpTokens", Record.owner_id == user.id).with_for_update())
    if row is None:
        raise HTTPException(404, "MCP_TOKEN_NOT_FOUND")
    row.data = {**row.data, "revokedAt": row.data.get("revokedAt") or utc_now().isoformat()}
    db.commit()
    return Response(status_code=204, headers={"Cache-Control": "no-store"})
