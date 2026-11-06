from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, EmailStr, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth.email_delivery import EmailDeliveryError, deliver_registration_code
from ..auth.rate_limit import AuthRateLimiter, request_client_ip
from ..auth.service import (
    issue_registration_code,
    login_with_password,
    public_user,
    register_user,
    resolve_web_session,
    revoke_web_session,
)
from ..config import Settings, get_settings
from ..app_time import parse_stored_timestamp
from ..database import Record, get_db
from ..models.workflows import DesktopCommand
from ..repositories.workflow_records import sync_workflow_record


router = APIRouter(prefix="/api/auth", tags=["auth"])


class EmailRequest(BaseModel):
    email: EmailStr


class RegisterRequest(EmailRequest):
    model_config = ConfigDict(populate_by_name=True)

    code: str = Field(min_length=4, max_length=12)
    password: str = Field(min_length=8, max_length=128)
    display_name: str = Field(default="", alias="displayName", max_length=160)


class LoginRequest(EmailRequest):
    password: str = Field(min_length=1, max_length=128)


class LogoutRequest(BaseModel):
    desktopDeviceId: str = Field(default="", max_length=120)


def sign_out_desktop(db: Session, device_id: str, owner_id: str) -> None:
    # Serialize with device verification/events. Keep historical ownership intact;
    # the agent will register a fresh, unbound identity on its next verification.
    row = db.scalar(select(Record).where(
        Record.id == device_id, Record.kind == "desktopDevices"
    ).with_for_update().execution_options(populate_existing=True))
    if row is None or row.owner_id != owner_id or row.data.get("boundOwnerId") != owner_id:
        raise HTTPException(status_code=403, detail="DESKTOP_DEVICE_OWNER_MISMATCH")
    pending = db.scalar(select(DesktopCommand.id).where(
        DesktopCommand.device_id == device_id,
        DesktopCommand.status.in_(["queued", "running"]),
    ).limit(1))
    authorization_sessions = db.scalars(select(Record).where(
        Record.kind == "mediaAuthSessions",
        Record.owner_id == owner_id,
        Record.data["deviceId"].as_string() == device_id,
        Record.data["status"].as_string().in_([
            "desktop_ready", "login_opened", "capturing", "verified", "submitted", "artifact_submitted",
        ]),
    ).execution_options(yield_per=100))
    now = datetime.now(timezone.utc)
    authorizing = False
    expired_sessions = []
    for session in authorization_sessions:
        # Foreground authorizations can be abandoned without an auth_failed
        # callback. Respect their existing 15-minute lease rather than trapping
        # the member forever on a historical login_opened/capturing record.
        expires_at = parse_stored_timestamp(session.data.get("expiresAt"))
        if expires_at is None:
            created_at = session.created_at
            if created_at.tzinfo is None:
                created_at = created_at.replace(tzinfo=timezone.utc)
            expires_at = created_at + timedelta(minutes=15)
        if expires_at > now:
            authorizing = True
            break
        expired_sessions.append(session)
    if pending:
        raise HTTPException(status_code=409, detail="DESKTOP_WORK_IN_PROGRESS")
    if authorizing:
        raise HTTPException(status_code=409, detail="DESKTOP_AUTH_IN_PROGRESS")
    for session in expired_sessions:
        session.data = {**session.data, "status": "expired",
                        "failureReason": "AUTH_SESSION_EXPIRED", "updatedAt": now.isoformat()}
        sync_workflow_record(db, "mediaAuthSessions", session.data)
    row.data = {**row.data, "status": "signed_out", "deviceTokenHash": "",
                "updatedAt": datetime.now(timezone.utc).isoformat()}
    sync_workflow_record(db, "desktopDevices", row.data)
    # The caller revokes the web session and commits both changes together.


def _session_token(request: Request) -> str:
    return request.cookies.get(get_settings().auth_cookie_name, "")


def _set_session_cookie(response: Response, settings: Settings, raw_token: str) -> None:
    response.set_cookie(
        key=settings.auth_cookie_name,
        value=raw_token,
        max_age=settings.auth_session_ttl_days * 24 * 60 * 60,
        httponly=True,
        secure=settings.auth_cookie_secure,
        samesite=settings.auth_cookie_samesite,
        path="/",
    )


@router.post("/register/request-code", status_code=202)
def request_registration_code(
    payload: EmailRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> dict:
    settings = get_settings()
    AuthRateLimiter(settings).enforce(
        "register-code",
        email=str(payload.email),
        ip=request_client_ip(request),
    )
    issued = issue_registration_code(
        db,
        settings,
        str(payload.email),
        requested_ip=request.client.host if request.client else "",
    )
    try:
        deliver_registration_code(settings, issued)
    except EmailDeliveryError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    response = {"accepted": True, "expiresIn": issued.expires_in}
    if settings.auth_debug_return_code:
        response["debugCode"] = issued.code
    return response


@router.post("/register", status_code=201)
def register(
    payload: RegisterRequest,
    response: Response,
    db: Session = Depends(get_db),
) -> dict:
    settings = get_settings()
    user, raw_token = register_user(
        db,
        settings,
        str(payload.email),
        payload.code,
        payload.password,
        payload.display_name,
    )
    _set_session_cookie(response, settings, raw_token)
    return {"authenticated": True, "user": public_user(user)}


@router.post("/login")
def login(
    payload: LoginRequest,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
) -> dict:
    settings = get_settings()
    AuthRateLimiter(settings).enforce(
        "login",
        email=str(payload.email),
        ip=request_client_ip(request),
    )
    user, raw_token = login_with_password(db, settings, str(payload.email), payload.password)
    _set_session_cookie(response, settings, raw_token)
    return {"authenticated": True, "user": public_user(user)}


@router.get("/me")
def current_user(request: Request, db: Session = Depends(get_db)) -> dict:
    resolved = resolve_web_session(db, _session_token(request))
    if resolved is None:
        raise HTTPException(status_code=401, detail="AUTHENTICATION_REQUIRED")
    user, _ = resolved
    return {"authenticated": True, "user": public_user(user)}


@router.post("/logout", status_code=204)
def logout(request: Request, response: Response, payload: LogoutRequest | None = None, db: Session = Depends(get_db)) -> Response:
    settings = get_settings()
    if payload and payload.desktopDeviceId:
        resolved = resolve_web_session(db, _session_token(request))
        if resolved is None:
            raise HTTPException(status_code=401, detail="AUTHENTICATION_REQUIRED")
        sign_out_desktop(db, payload.desktopDeviceId, resolved[0].id)
    revoke_web_session(db, _session_token(request))
    response.delete_cookie(
        key=settings.auth_cookie_name,
        path="/",
        secure=settings.auth_cookie_secure,
        httponly=True,
        samesite=settings.auth_cookie_samesite,
    )
    response.status_code = 204
    return response
