from __future__ import annotations

import os


def resolve_migration_database_url(configured_url: str | None, fallback_url: str | None = None) -> str:
    """Resolve the migration database without overriding explicit test configuration."""
    normalized_config = (configured_url or "").strip()
    if normalized_config:
        return normalized_config

    environment_url = os.getenv("DATABASE_URL", "").strip()
    if environment_url:
        return environment_url

    normalized_fallback = (fallback_url or "").strip()
    if normalized_fallback:
        return normalized_fallback

    raise RuntimeError("DATABASE_URL_NOT_CONFIGURED")