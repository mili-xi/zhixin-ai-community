from __future__ import annotations

import os
from datetime import datetime

from sqlalchemy.orm import Session

from .app_time import now as app_now
from .service import (
    find_record,
    list_records,
    now_stamp,
    parse_desktop_command_timestamp,
    patch_record,
)


DESKTOP_DEVICE_LIVE_SECONDS = 900


DESKTOP_ASSET_CLEANUP_MIN_VERSION_ENV = "ZX_DESKTOP_ASSET_CLEANUP_MIN_VERSION"
DESKTOP_ASSET_CLEANUP_DEFAULT_MIN_VERSION = "0.1.14"


def _desktop_version_parts(version: str) -> tuple[list[int], str] | None:
    """Split a desktop version into numeric segments and a pre-release tag.

    Only the leading digits of each dot segment count, so a tag such as
    "0.1.14-beta" still resolves to the numbers it ships as.
    """
    text = str(version or "").strip().lower()
    if not text:
        return None
    core, _, tag = text.partition("-")
    numbers: list[int] = []
    for segment in core.split("."):
        digits = ""
        for character in segment:
            if not character.isdigit():
                break
            digits += character
        if not digits:
            break
        numbers.append(int(digits))
    if not numbers:
        return None
    return numbers, tag.strip()


def desktop_version_at_least(version: str, minimum: str) -> bool:
    """Report whether a desktop version is at least the required floor.

    An unparseable version is never good enough: the asset cleanup deletes
    local files, so an agent that cannot state its version must not receive
    the command.
    """
    left = _desktop_version_parts(version)
    right = _desktop_version_parts(minimum)
    if not left or not right:
        return False
    left_numbers, left_tag = left
    right_numbers, right_tag = right
    length = max(len(left_numbers), len(right_numbers))
    left_numbers = left_numbers + [0] * (length - len(left_numbers))
    right_numbers = right_numbers + [0] * (length - len(right_numbers))
    if left_numbers != right_numbers:
        return left_numbers > right_numbers
    # Same numbers: a pre-release tag predates the same numbers without one.
    if left_tag == right_tag:
        return True
    return not left_tag


def desktop_asset_cleanup_min_version() -> str:
    raw = (os.environ.get(DESKTOP_ASSET_CLEANUP_MIN_VERSION_ENV) or "").strip()
    return raw or DESKTOP_ASSET_CLEANUP_DEFAULT_MIN_VERSION


def desktop_supports_asset_cleanup(device: dict | None) -> bool:
    """Gate the destructive cleanup command on the device's own version.

    Registration freezes appVersion on the server, so a device that upgraded
    its installer stays on the old number until a heartbeat refreshes it.
    """
    version = str((device or {}).get("appVersion") or "").strip()
    if not version:
        return False
    return desktop_version_at_least(version, desktop_asset_cleanup_min_version())


def active_media_account_binding(db: Session, account_id: str, device_id: str = "") -> dict | None:
    return next((
        item for item in reversed(list_records(db, "mediaAccountBindings"))
        if item.get("mediaAccountId") == account_id
        and item.get("status") == "active"
        and (not device_id or item.get("deviceId") == device_id)
    ), None)


def desktop_device_is_live(device: dict | None, now: datetime | None = None) -> bool:
    """A device counts as live when it is active and heartbeated recently."""
    if not device or str(device.get("status") or "active") != "active":
        return False
    if now is None:
        # The API/worker containers run on a UTC clock, so a bare datetime.now()
        # would produce UTC wall-clock digits that get mislabelled with the
        # device's +08:00 offset and skew liveness by eight hours. Resolve the
        # default "now" the same way every persisted stamp does.
        now = app_now()
    timestamp = parse_desktop_command_timestamp(device.get("lastSeenAt"), now=now)
    if not timestamp:
        return False
    current = now
    # Compare in the stamp's own zone. Stripping the offset instead would
    # reinterpret the wall-clock digits as UTC and skew liveness by 8 hours.
    if current.tzinfo is None:
        current = current.replace(tzinfo=timestamp.tzinfo)
    else:
        current = current.astimezone(timestamp.tzinfo)
    return abs((current - timestamp).total_seconds()) <= DESKTOP_DEVICE_LIVE_SECONDS


def owner_live_channel_device(db: Session, owner_id: str, now: datetime | None = None) -> dict | None:
    if not owner_id:
        return None
    live_devices = [
        device for device in list_records(db, "desktopDevices")
        if str(device.get("boundOwnerId") or "") == owner_id
        and desktop_device_is_live(device, now=now)
    ]
    if not live_devices:
        return None
    return max(live_devices, key=lambda device: (
        (parse_desktop_command_timestamp(device.get("lastSeenAt")) or datetime.min).replace(tzinfo=None),
        str(device.get("id") or ""),
    ))


def resolve_media_account_channel_device(db: Session, bound_device_id: str, now: datetime | None = None) -> str:
    """Pick the device that should run commands for an account.

    Bindings created long ago keep pointing at devices that no longer exist,
    which strands validate/publish commands on zombie devices. When the bound
    device is not live, fall back to the owner's most recently seen live device.
    """
    bound_device = find_record(db, "desktopDevices", bound_device_id) if bound_device_id else None
    if bound_device and desktop_device_is_live(bound_device, now=now):
        return bound_device_id
    live_device = owner_live_channel_device(db, str((bound_device or {}).get("boundOwnerId") or ""), now=now)
    if live_device and str(live_device.get("id") or ""):
        return str(live_device["id"])
    return bound_device_id


def point_media_account_binding_at_device(db: Session, account_id: str, device_id: str) -> dict | None:
    if not device_id:
        return None
    binding = active_media_account_binding(db, account_id)
    if not binding or str(binding.get("deviceId") or "") == device_id:
        return binding
    return patch_record(db, "mediaAccountBindings", binding["id"], {
        "deviceId": device_id,
        "updatedAt": now_stamp(),
    })


def adopt_media_account_binding_for_live_device(db: Session, account_id: str, device_id: str) -> dict | None:
    """Let a live device take over a binding stranded on a dead/unknown device."""
    binding = active_media_account_binding(db, account_id)
    if not binding or not device_id or str(binding.get("deviceId") or "") == device_id:
        return binding
    device = find_record(db, "desktopDevices", device_id)
    if not desktop_device_is_live(device):
        return binding
    previous_device = find_record(db, "desktopDevices", str(binding.get("deviceId") or ""))
    if previous_device and desktop_device_is_live(previous_device):
        return binding
    previous_owner = str((previous_device or {}).get("boundOwnerId") or "")
    if previous_owner and previous_owner != str(device.get("boundOwnerId") or ""):
        return binding
    return point_media_account_binding_at_device(db, account_id, device_id)


def desktop_command_target_device_is_live(db: Session, command: dict) -> bool:
    device_id = str(command.get("deviceId") or "")
    if not device_id:
        return True
    return desktop_device_is_live(find_record(db, "desktopDevices", device_id))
