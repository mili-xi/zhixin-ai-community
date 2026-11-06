from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import Settings
from ..models.auth import EmailVerificationCode, User, WebSession
from .context import ActorContext, ActorRole
from .security import (
    generate_numeric_code,
    generate_secret,
    hash_password,
    hash_secret,
    verify_password,
    verify_secret,
)


@dataclass(frozen=True, slots=True)
class IssuedRegistrationCode:
    email: str
    code: str
    expires_in: int


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def normalize_email(value: str) -> str:
    return value.strip().lower()


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def issue_registration_code(
    db: Session,
    settings: Settings,
    email: str,
    requested_ip: str = "",
) -> IssuedRegistrationCode:
    if not settings.auth_registration_enabled:
        raise HTTPException(status_code=403, detail="REGISTRATION_DISABLED")

    normalized = normalize_email(email)
    existing_user = db.scalar(select(User).where(User.email == normalized))
    if existing_user is not None and existing_user.password_hash:
        raise HTTPException(status_code=409, detail="EMAIL_ALREADY_REGISTERED")

    now = utc_now()
    active_codes = db.scalars(
        select(EmailVerificationCode).where(
            EmailVerificationCode.email == normalized,
            EmailVerificationCode.purpose == "register",
            EmailVerificationCode.consumed_at.is_(None),
        )
    ).all()
    for active_code in active_codes:
        active_code.consumed_at = now

    code = generate_numeric_code()
    db.add(
        EmailVerificationCode(
            id=f"email-code-{uuid4().hex}",
            email=normalized,
            purpose="register",
            code_hash=hash_secret(code),
            expires_at=now + timedelta(seconds=settings.auth_code_ttl_seconds),
            requested_ip=requested_ip[:120],
        )
    )
    db.commit()
    return IssuedRegistrationCode(
        email=normalized,
        code=code,
        expires_in=settings.auth_code_ttl_seconds,
    )


def _consume_registration_code(
    db: Session,
    settings: Settings,
    email: str,
    code: str,
) -> str:
    normalized = normalize_email(email)
    verification = db.scalar(
        select(EmailVerificationCode)
        .where(
            EmailVerificationCode.email == normalized,
            EmailVerificationCode.purpose == "register",
            EmailVerificationCode.consumed_at.is_(None),
        )
        .order_by(EmailVerificationCode.created_at.desc(), EmailVerificationCode.id.desc())
        .limit(1)
    )
    now = utc_now()
    if verification is None or _aware(verification.expires_at) <= now:
        raise HTTPException(status_code=401, detail="REGISTRATION_CODE_INVALID_OR_EXPIRED")
    if verification.attempts >= settings.auth_code_max_attempts:
        verification.consumed_at = now
        db.commit()
        raise HTTPException(status_code=401, detail="REGISTRATION_CODE_INVALID_OR_EXPIRED")
    if not verify_secret(code.strip(), verification.code_hash):
        verification.attempts += 1
        if verification.attempts >= settings.auth_code_max_attempts:
            verification.consumed_at = now
        db.commit()
        raise HTTPException(status_code=401, detail="REGISTRATION_CODE_INVALID_OR_EXPIRED")

    verification.consumed_at = now
    return normalized


def _create_web_session(db: Session, settings: Settings, user: User, now: datetime) -> str:
    raw_token = generate_secret()
    db.add(
        WebSession(
            id=f"web-session-{uuid4().hex}",
            user_id=user.id,
            token_hash=hash_secret(raw_token),
            expires_at=now + timedelta(days=settings.auth_session_ttl_days),
            last_seen_at=now,
        )
    )
    return raw_token


def register_user(
    db: Session,
    settings: Settings,
    email: str,
    code: str,
    password: str,
    display_name: str = "",
) -> tuple[User, str]:
    if not settings.auth_registration_enabled:
        raise HTTPException(status_code=403, detail="REGISTRATION_DISABLED")

    normalized = normalize_email(email)
    existing_user = db.scalar(select(User).where(User.email == normalized))
    if existing_user is not None and existing_user.password_hash:
        raise HTTPException(status_code=409, detail="EMAIL_ALREADY_REGISTERED")

    normalized = _consume_registration_code(db, settings, normalized, code)
    now = utc_now()
    user = existing_user
    if user is None:
        user = User(
            id=f"user-{uuid4().hex}",
            email=normalized,
            display_name=display_name.strip() or normalized.split("@", 1)[0],
            role=ActorRole.MEMBER.value,
            status="active",
        )
        db.add(user)
    elif user.status != "active":
        raise HTTPException(status_code=403, detail="USER_DISABLED")
    else:
        user.display_name = display_name.strip() or user.display_name or normalized.split("@", 1)[0]

    user.password_hash = hash_password(password)
    user.password_changed_at = now
    user.last_login_at = now
    db.flush()
    raw_token = _create_web_session(db, settings, user, now)
    db.commit()
    db.refresh(user)
    return user, raw_token


def login_with_password(
    db: Session,
    settings: Settings,
    email: str,
    password: str,
) -> tuple[User, str]:
    normalized = normalize_email(email)
    user = db.scalar(select(User).where(User.email == normalized))
    if user is None or not verify_password(password, user.password_hash):
        raise HTTPException(status_code=401, detail="INVALID_EMAIL_OR_PASSWORD")
    if user.status != "active":
        raise HTTPException(status_code=403, detail="USER_DISABLED")

    now = utc_now()
    user.last_login_at = now
    raw_token = _create_web_session(db, settings, user, now)
    db.commit()
    db.refresh(user)
    return user, raw_token


def resolve_web_session(db: Session, raw_token: str) -> tuple[User, WebSession] | None:
    if not raw_token:
        return None
    web_session = db.scalar(select(WebSession).where(WebSession.token_hash == hash_secret(raw_token)))
    now = utc_now()
    if (
        web_session is None
        or web_session.revoked_at is not None
        or _aware(web_session.expires_at) <= now
    ):
        return None
    user = db.get(User, web_session.user_id)
    if user is None or user.status != "active":
        return None
    web_session.last_seen_at = now
    db.commit()
    return user, web_session


def revoke_web_session(db: Session, raw_token: str) -> None:
    if not raw_token:
        return
    web_session = db.scalar(select(WebSession).where(WebSession.token_hash == hash_secret(raw_token)))
    if web_session is not None and web_session.revoked_at is None:
        web_session.revoked_at = utc_now()
        db.commit()


def actor_for_user(user: User) -> ActorContext:
    return ActorContext(user_id=user.id, role=ActorRole(user.role))


def public_user(user: User) -> dict[str, str]:
    return {
        "id": user.id,
        "email": user.email,
        "displayName": user.display_name,
        "role": user.role,
        "status": user.status,
    }