from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import secrets

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from .auth.context import ActorContext, ActorRole, current_actor
from .auth.security import verify_secret
from .database import Record
from .models.workflows import DesktopDevice
from .repositories.workflow_records import sync_workflow_record


def _aware_datetime(value: object) -> datetime | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=timezone.utc)


def unscoped_record(db: Session, kind: str, record_id: str) -> Record | None:
    row = db.get(Record, record_id)
    if row is None or row.kind != kind:
        return None
    return row


def require_unscoped_desktop_device(db: Session, device_id: str, device_token: str) -> dict:
    # A concurrent logout must not be overwritten by a stale verify/heartbeat.
    row = db.scalar(select(Record).where(
        Record.id == device_id, Record.kind == "desktopDevices"
    ).with_for_update().execution_options(populate_existing=True))
    device = dict(row.data) if row is not None else None
    if (
        device is None
        or device.get("status") == "signed_out"
        or not device_token
        or not secrets.compare_digest(
            str(device.get("deviceTokenHash") or ""),
            hashlib.sha256(device_token.encode("utf-8")).hexdigest(),
        )
    ):
        raise HTTPException(status_code=403, detail="DESKTOP_DEVICE_AUTH_REQUIRED")
    return device


def require_desktop_agent_device(db: Session, device_id: str, device_token: str) -> dict:
    """Authenticate a desktop Agent without accepting a Web actor as a substitute."""
    return require_unscoped_desktop_device(db, device_id, device_token)


def desktop_actor_for_device(db: Session, device_id: str, device_token: str) -> ActorContext | None:
    device = require_unscoped_desktop_device(db, device_id, device_token)
    owner_id = str(device.get("boundOwnerId") or "").strip()
    if not owner_id:
        return None
    return ActorContext(user_id=owner_id, role=ActorRole.SYSTEM_WORKER, device_id=device_id)


def require_desktop_device_for_actor(db: Session, device_id: str, device_token: str = "") -> dict:
    actor = current_actor()
    if device_token:
        device = require_unscoped_desktop_device(db, device_id, device_token)
    elif actor is not None:
        row = db.scalar(select(Record).where(
            Record.id == device_id, Record.kind == "desktopDevices"
        ).with_for_update().execution_options(populate_existing=True))
        device = dict(row.data) if row is not None else None
        if device is None or str(row.owner_id or "") != actor.owner_id:
            raise HTTPException(status_code=403, detail="DESKTOP_DEVICE_AUTH_REQUIRED")
    else:
        raise HTTPException(status_code=403, detail="DESKTOP_DEVICE_AUTH_REQUIRED")

    bound_owner_id = str(device.get("boundOwnerId") or "").strip()
    if device.get("status") == "signed_out":
        raise HTTPException(status_code=403, detail="DESKTOP_DEVICE_AUTH_REQUIRED")
    if actor is not None and bound_owner_id and actor.owner_id != bound_owner_id:
        raise HTTPException(status_code=403, detail="DESKTOP_DEVICE_OWNER_MISMATCH")
    return device


def require_desktop_command_device_owner(db: Session, device_id: str) -> dict:
    """Reject a desktop command aimed at a device bound to another owner.

    Mirrors the boundOwnerId gate in require_desktop_device_for_actor: an
    unbound or unknown device is not a mismatch, a device bound to a
    different owner than the current actor is rejected with 403.
    """
    actor = current_actor()
    row = unscoped_record(db, "desktopDevices", device_id)
    device = dict(row.data) if row is not None else None
    bound_owner_id = str((device or {}).get("boundOwnerId") or "").strip()
    if (device or {}).get("status") == "signed_out":
        raise HTTPException(status_code=409, detail="DESKTOP_DEVICE_SIGNED_OUT")
    if actor is not None and bound_owner_id and actor.owner_id != bound_owner_id:
        raise HTTPException(status_code=403, detail="DESKTOP_DEVICE_OWNER_MISMATCH")
    return device or {}


def claim_owner_binding(
    db: Session,
    *,
    binding_id: str,
    device_id: str,
    device_token: str,
    pairing_code: str,
    now: datetime | None = None,
) -> tuple[dict, dict]:
    device_row = unscoped_record(db, "desktopDevices", device_id)
    binding_row = unscoped_record(db, "desktopOwnerBindings", binding_id)
    device = require_unscoped_desktop_device(db, device_id, device_token)
    if binding_row is None:
        raise HTTPException(status_code=404, detail="DESKTOP_OWNER_BINDING_NOT_FOUND")

    binding = dict(binding_row.data)
    owner_id = str(binding_row.owner_id or binding.get("ownerId") or "").strip()
    if not owner_id:
        raise HTTPException(status_code=400, detail="DESKTOP_OWNER_BINDING_OWNER_REQUIRED")
    if binding.get("status") != "waiting_desktop":
        raise HTTPException(status_code=409, detail="DESKTOP_OWNER_BINDING_NOT_CLAIMABLE")

    expires_at = _aware_datetime(binding.get("expiresAt"))
    current_time = now or datetime.now(timezone.utc)
    if expires_at is None or expires_at <= current_time:
        binding["status"] = "expired"
        binding["updatedAt"] = current_time.isoformat()
        binding_row.data = binding
        db.commit()
        raise HTTPException(status_code=410, detail="DESKTOP_OWNER_BINDING_EXPIRED")
    if not verify_secret(pairing_code.strip(), str(binding.get("pairingCodeHash") or "")):
        raise HTTPException(status_code=400, detail="PAIRING_CODE_INVALID")

    existing_owner_id = str(device.get("boundOwnerId") or "").strip()
    if existing_owner_id and existing_owner_id != owner_id:
        raise HTTPException(status_code=409, detail="DESKTOP_DEVICE_ALREADY_BOUND")

    bound_at = current_time.isoformat()
    device = {
        **device,
        "ownerId": owner_id,
        "boundOwnerId": owner_id,
        "ownerBoundAt": bound_at,
        "lastSeenAt": bound_at,
        "updatedAt": bound_at,
    }
    binding = {
        **binding,
        "ownerId": owner_id,
        "deviceId": device_id,
        "status": "claimed",
        "claimedAt": bound_at,
        "updatedAt": bound_at,
    }
    assert device_row is not None
    device_row.owner_id = owner_id
    device_row.data = device
    binding_row.data = binding
    sync_workflow_record(db, "desktopDevices", device)
    db.commit()

    return device, binding


def public_owner_binding(binding: dict) -> dict:
    return {key: value for key, value in binding.items() if key != "pairingCodeHash"}


def public_desktop_device(device: dict) -> dict:
    return {key: value for key, value in device.items() if key != "deviceTokenHash"}
