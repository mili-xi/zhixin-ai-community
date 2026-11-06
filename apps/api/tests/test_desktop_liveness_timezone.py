from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app import app_time, desktop_channels


class _FakeUTCClock(datetime):
    """Emulate the production containers: a UTC clock whose bare .now() is naive UTC wall time."""

    @classmethod
    def now(cls, tz=None):
        return cls(2026, 10, 28, 1, 0, 0)


def test_desktop_device_is_live_defaults_to_display_timezone(monkeypatch):
    display_now = datetime(2026, 10, 28, 9, 0, 0, tzinfo=timezone(timedelta(hours=8)))
    monkeypatch.setattr(desktop_channels, "app_now", lambda: display_now)
    monkeypatch.setattr(desktop_channels, "datetime", _FakeUTCClock)

    fresh = {"id": "d1", "status": "active", "lastSeenAt": "2026-10-28T09:00:00+08:00"}
    assert desktop_channels.desktop_device_is_live(fresh) is True

    stale = {"id": "d2", "status": "active", "lastSeenAt": "2026-10-28T08:40:00+08:00"}
    assert desktop_channels.desktop_device_is_live(stale) is False
