from __future__ import annotations

from fastapi import HTTPException

from app.auth.rate_limit import AuthRateLimiter, reset_auth_rate_limit_state
from app.config import Settings, csv_setting


def make_settings(**overrides) -> Settings:
    values = {
        "database_url": "sqlite://",
        "redis_url": "memory://auth-rate-limit-tests",
        "auth_rate_limit_enabled": True,
        "auth_rate_limit_window_seconds": 60,
        "auth_register_code_email_limit": 2,
        "auth_register_code_ip_limit": 3,
        "auth_login_email_limit": 2,
        "auth_login_ip_limit": 4,
    }
    values.update(overrides)
    return Settings(**values)


def test_csv_setting_normalizes_and_deduplicates_values() -> None:
    assert csv_setting(" https://example.com.cn, localhost,https://example.com.cn ") == [
        "https://example.com.cn",
        "localhost",
    ]


def test_registration_code_limit_is_scoped_by_email_and_ip() -> None:
    reset_auth_rate_limit_state()
    limiter = AuthRateLimiter(make_settings())

    limiter.enforce("register-code", email="member@example.com", ip="203.0.113.10")
    limiter.enforce("register-code", email="member@example.com", ip="203.0.113.10")

    try:
        limiter.enforce("register-code", email="member@example.com", ip="203.0.113.10")
    except HTTPException as exc:
        assert exc.status_code == 429
        assert exc.detail == "AUTH_RATE_LIMITED"
        assert exc.headers and int(exc.headers["Retry-After"]) > 0
    else:
        raise AssertionError("expected the email rate limit to reject the third request")


def test_login_ip_limit_applies_across_multiple_emails() -> None:
    reset_auth_rate_limit_state()
    limiter = AuthRateLimiter(
        make_settings(auth_login_email_limit=10, auth_login_ip_limit=2)
    )

    limiter.enforce("login", email="first@example.com", ip="203.0.113.20")
    limiter.enforce("login", email="second@example.com", ip="203.0.113.20")

    try:
        limiter.enforce("login", email="third@example.com", ip="203.0.113.20")
    except HTTPException as exc:
        assert exc.status_code == 429
        assert exc.detail == "AUTH_RATE_LIMITED"
    else:
        raise AssertionError("expected the shared IP rate limit to reject the request")


def test_disabled_rate_limit_does_not_touch_backend() -> None:
    reset_auth_rate_limit_state()
    limiter = AuthRateLimiter(make_settings(auth_rate_limit_enabled=False))

    for _ in range(20):
        limiter.enforce("login", email="member@example.com", ip="203.0.113.30")
