from __future__ import annotations

import hashlib
import threading
import time
from dataclasses import dataclass
from typing import Callable

import redis
from fastapi import HTTPException, Request

from ..config import Settings


@dataclass(frozen=True)
class RateLimitPolicy:
    email_limit: int
    ip_limit: int


_memory_lock = threading.Lock()
_memory_counters: dict[tuple[str, str], tuple[int, float]] = {}
_redis_lock = threading.Lock()
_redis_clients: dict[str, redis.Redis] = {}


class AuthRateLimiter:
    _INCREMENT_SCRIPT = """
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('TTL', KEYS[1])
return {current, ttl}
"""

    def __init__(self, settings: Settings, *, time_fn: Callable[[], float] = time.time):
        self.settings = settings
        self.time_fn = time_fn

    def enforce(self, action: str, *, email: str, ip: str) -> None:
        if not self.settings.auth_rate_limit_enabled:
            return
        policy = self._policy(action)
        self._enforce_dimension(action, "email", email.strip().lower(), policy.email_limit)
        self._enforce_dimension(action, "ip", ip.strip() or "unknown", policy.ip_limit)

    def _policy(self, action: str) -> RateLimitPolicy:
        policies = {
            "register-code": RateLimitPolicy(
                email_limit=self.settings.auth_register_code_email_limit,
                ip_limit=self.settings.auth_register_code_ip_limit,
            ),
            "login": RateLimitPolicy(
                email_limit=self.settings.auth_login_email_limit,
                ip_limit=self.settings.auth_login_ip_limit,
            ),
        }
        try:
            return policies[action]
        except KeyError as exc:
            raise ValueError(f"unsupported auth rate-limit action: {action}") from exc

    def _enforce_dimension(self, action: str, dimension: str, value: str, limit: int) -> None:
        if limit <= 0:
            return
        digest = hashlib.sha256(value.encode("utf-8")).hexdigest()
        key = f"zhixin:auth-rate:{action}:{dimension}:{digest}"
        count, ttl = self._increment(key)
        if count > limit:
            raise HTTPException(
                status_code=429,
                detail="AUTH_RATE_LIMITED",
                headers={"Retry-After": str(max(int(ttl), 1))},
            )

    def _increment(self, key: str) -> tuple[int, int]:
        window = max(int(self.settings.auth_rate_limit_window_seconds), 1)
        if self.settings.redis_url.startswith("memory://"):
            return self._increment_memory(key, window)
        try:
            client = _redis_client(self.settings.redis_url)
            result = client.eval(self._INCREMENT_SCRIPT, 1, key, window)
            return int(result[0]), max(int(result[1]), 1)
        except redis.RedisError as exc:
            raise HTTPException(
                status_code=503,
                detail="AUTH_RATE_LIMIT_BACKEND_UNAVAILABLE",
            ) from exc

    def _increment_memory(self, key: str, window: int) -> tuple[int, int]:
        now = self.time_fn()
        storage_key = (self.settings.redis_url, key)
        with _memory_lock:
            count, expires_at = _memory_counters.get(storage_key, (0, now + window))
            if expires_at <= now:
                count, expires_at = 0, now + window
            count += 1
            _memory_counters[storage_key] = (count, expires_at)
        return count, max(int(expires_at - now), 1)


def _redis_client(redis_url: str) -> redis.Redis:
    with _redis_lock:
        client = _redis_clients.get(redis_url)
        if client is None:
            client = redis.from_url(redis_url, decode_responses=True, protocol=2)
            _redis_clients[redis_url] = client
        return client


def request_client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",", 1)[0].strip()
    return request.client.host if request.client else "unknown"


def reset_auth_rate_limit_state() -> None:
    with _memory_lock:
        _memory_counters.clear()
    with _redis_lock:
        clients = list(_redis_clients.values())
        _redis_clients.clear()
    for client in clients:
        try:
            client.close()
        except redis.RedisError:
            pass
