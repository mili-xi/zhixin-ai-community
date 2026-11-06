from __future__ import annotations

from datetime import datetime, timedelta, timezone


PLATFORM_CREDENTIAL_CHECK_HOURS = {
    "netease": 6,
    "penguin": 6,
    "sohu": 18,
    "jianshu": 18,
    "zhihu": 48,
    "baijiahao": 48,
    "csdn": 48,
    "toutiao": 48,
}


def credential_check_hours(platform: str) -> int:
    return PLATFORM_CREDENTIAL_CHECK_HOURS.get(str(platform or "").lower(), 24)


def parse_credential_timestamp(value: str) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def next_credential_check_at(
    platform: str,
    credential_expires_at: str = "",
    now: datetime | None = None,
) -> str:
    current = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    scheduled = current + timedelta(hours=credential_check_hours(platform))
    expires_at = parse_credential_timestamp(credential_expires_at)
    if expires_at:
        refresh_before_expiry = expires_at - timedelta(hours=1)
        scheduled = min(
            scheduled,
            current + timedelta(minutes=15) if refresh_before_expiry <= current else refresh_before_expiry,
        )
    return scheduled.isoformat()


def credential_retry_at(now: datetime | None = None, minutes: int = 15) -> str:
    current = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    return (current + timedelta(minutes=minutes)).isoformat()


def preserve_editor_token_expiry(metadata: dict, previous_metadata: dict) -> dict:
    """Keep the last known editor-token evidence when a newer report lost it.

    Some platform editors mint a short-lived runtime token into localStorage
    (百家号 writes an `edit-token` JWT that dies in 12 hours) while the persistent
    cookies live for months. A report captured after the editor cleaned that token
    only carries cookie expiry, so accepting it wholesale would push
    credentialExpiresAt months into the future and reset the account to active.
    A report that carries a fresh editor token replaces the stored evidence
    normally; only a report that dropped it is reconciled against the last one.
    """
    if not isinstance(metadata, dict):
        metadata = {}
    if not isinstance(previous_metadata, dict):
        return metadata
    if not previous_metadata.get("editorTokenExpiresAt") or metadata.get("editorTokenExpiresAt"):
        return metadata

    merged = dict(metadata)
    merged["editorTokenExpiresAt"] = previous_metadata.get("editorTokenExpiresAt")
    if previous_metadata.get("editorTokenTtlSeconds") is not None:
        merged["editorTokenTtlSeconds"] = previous_metadata.get("editorTokenTtlSeconds")
    previous_expires_at = str(previous_metadata.get("credentialExpiresAt") or "")
    current_expires_at = parse_credential_timestamp(str(merged.get("credentialExpiresAt") or ""))
    previous_expires = parse_credential_timestamp(previous_expires_at)
    if previous_expires and (not current_expires_at or previous_expires < current_expires_at):
        merged["credentialExpiresAt"] = previous_expires_at
    return merged


def credential_validation_is_due(account: dict, now: datetime | None = None) -> bool:
    scheduled = parse_credential_timestamp(str(account.get("nextCredentialCheckAt") or ""))
    if not scheduled:
        return True
    current = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    return scheduled <= current
