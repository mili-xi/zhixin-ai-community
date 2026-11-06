from __future__ import annotations

import json
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable
from uuid import uuid4

import redis

from .config import get_settings


QUEUE_META_KEY = "_queue"
QUEUE_VERSION = 1


@dataclass(frozen=True)
class QueueMessage:
    queue: str
    message_id: str
    payload: dict[str, Any]
    attempt: int = 0
    lease_until: float = 0.0
    enqueued_at: float = 0.0
    last_error: str = ""
    raw: str = field(default="", repr=False, compare=False)


def encode_queue_message(
    payload: dict[str, Any],
    *,
    message_id: str | None = None,
    attempt: int = 0,
    enqueued_at: float | None = None,
    last_error: str = "",
) -> str:
    envelope = {
        QUEUE_META_KEY: {
            "version": QUEUE_VERSION,
            "id": message_id or str(uuid4()),
            "attempt": max(int(attempt), 0),
            "enqueuedAt": float(enqueued_at if enqueued_at is not None else time.time()),
            "lastError": str(last_error or ""),
        },
        "payload": payload,
    }
    return json.dumps(envelope, ensure_ascii=False, separators=(",", ":"))


def decode_queue_message(
    raw: str | bytes,
    *,
    queue: str,
    fallback_id: str | None = None,
    lease_until: float = 0.0,
) -> QueueMessage:
    raw_text = raw.decode("utf-8") if isinstance(raw, bytes) else str(raw)
    decoded = json.loads(raw_text)
    fallback = fallback_id or str(uuid4())
    if isinstance(decoded, dict) and isinstance(decoded.get(QUEUE_META_KEY), dict):
        metadata = decoded[QUEUE_META_KEY]
        payload = decoded.get("payload")
        if not isinstance(payload, dict):
            payload = {"value": payload}
        return QueueMessage(
            queue=queue,
            message_id=str(metadata.get("id") or fallback),
            payload=payload,
            attempt=max(int(metadata.get("attempt") or 0), 0),
            lease_until=float(lease_until),
            enqueued_at=float(metadata.get("enqueuedAt") or 0.0),
            last_error=str(metadata.get("lastError") or ""),
            raw=raw_text,
        )
    payload = decoded if isinstance(decoded, dict) else {"value": decoded}
    return QueueMessage(
        queue=queue,
        message_id=fallback,
        payload=payload,
        lease_until=float(lease_until),
        raw=raw_text,
    )


class MemoryQueueClient:
    def __init__(
        self,
        *,
        lease_seconds: float = 300.0,
        max_attempts: int = 3,
        time_fn: Callable[[], float] = time.time,
    ) -> None:
        self.prefix = "zhixin:queue"
        self.lease_seconds = max(float(lease_seconds), 1.0)
        self.max_attempts = max(int(max_attempts), 1)
        self.time_fn = time_fn
        self._ready: dict[str, list[str]] = {}
        self._processing: dict[str, dict[str, tuple[str, float]]] = {}
        self._dead: dict[str, list[str]] = {}
        self._lock = threading.RLock()

    def enqueue(self, queue: str, payload: dict[str, Any]) -> dict[str, Any]:
        raw = encode_queue_message(payload, enqueued_at=self.time_fn())
        with self._lock:
            self._ready.setdefault(queue, []).append(raw)
        return {"queued": True, "queue": f"{self.prefix}:{queue}"}

    def reserve(self, queues: list[str], timeout: int = 5) -> QueueMessage | None:
        deadline = time.monotonic() + max(float(timeout), 0.0)
        while True:
            self.reclaim_expired(queues)
            with self._lock:
                for queue in queues:
                    ready = self._ready.setdefault(queue, [])
                    if not ready:
                        continue
                    raw = ready.pop(0)
                    lease_until = self.time_fn() + self.lease_seconds
                    message = decode_queue_message(raw, queue=queue, lease_until=lease_until)
                    self._processing.setdefault(queue, {})[message.message_id] = (raw, lease_until)
                    return message
            if timeout <= 0 or time.monotonic() >= deadline:
                return None
            time.sleep(min(0.05, max(deadline - time.monotonic(), 0.0)))

    def ack(self, message: QueueMessage) -> bool:
        with self._lock:
            processing = self._processing.setdefault(message.queue, {})
            current = processing.get(message.message_id)
            if not current or current[0] != message.raw:
                return False
            del processing[message.message_id]
            return True

    def nack(self, message: QueueMessage, error: str, *, retryable: bool = True) -> dict[str, Any]:
        with self._lock:
            processing = self._processing.setdefault(message.queue, {})
            current = processing.get(message.message_id)
            if not current or current[0] != message.raw:
                return {"requeued": False, "deadLettered": False, "stale": True}
            del processing[message.message_id]
            next_attempt = message.attempt + 1
            raw = encode_queue_message(
                message.payload,
                message_id=message.message_id,
                attempt=next_attempt,
                enqueued_at=message.enqueued_at or self.time_fn(),
                last_error=error,
            )
            if retryable and next_attempt < self.max_attempts:
                self._ready.setdefault(message.queue, []).append(raw)
                return {"requeued": True, "deadLettered": False, "attempt": next_attempt}
            self._dead.setdefault(message.queue, []).append(raw)
            return {"requeued": False, "deadLettered": True, "attempt": next_attempt}

    def reclaim_expired(self, queues: list[str] | None = None) -> int:
        reclaimed = 0
        queue_names = list(queues or self._processing.keys())
        for queue in queue_names:
            with self._lock:
                expired = [
                    (message_id, raw, lease_until)
                    for message_id, (raw, lease_until) in self._processing.setdefault(queue, {}).items()
                    if lease_until <= self.time_fn()
                ]
            for message_id, raw, lease_until in expired:
                message = decode_queue_message(
                    raw,
                    queue=queue,
                    fallback_id=message_id,
                    lease_until=lease_until,
                )
                result = self.nack(message, "QUEUE_LEASE_EXPIRED")
                if not result.get("stale"):
                    reclaimed += 1
        return reclaimed

    def pop(self, queues: list[str], timeout: int = 5) -> tuple[str, dict[str, Any]] | None:
        message = self.reserve(queues, timeout=timeout)
        if not message:
            return None
        self.ack(message)
        return message.queue, message.payload

    def ready_count(self, queue: str) -> int:
        with self._lock:
            return len(self._ready.get(queue, []))

    def processing_count(self, queue: str) -> int:
        with self._lock:
            return len(self._processing.get(queue, {}))

    def dead_letters(self, queue: str) -> list[QueueMessage]:
        with self._lock:
            values = list(self._dead.get(queue, []))
        return [decode_queue_message(raw, queue=queue) for raw in values]


class QueueClient:
    _RESERVE_SCRIPT = """
-- zhixin_queue_reserve_v1
local raw = redis.call('RPOP', KEYS[1])
if not raw then return nil end
redis.call('LPUSH', KEYS[2], raw)
local message_id = ARGV[1]
local ok, decoded = pcall(cjson.decode, raw)
if ok and type(decoded) == 'table' and type(decoded['_queue']) == 'table' and decoded['_queue']['id'] then
  message_id = tostring(decoded['_queue']['id'])
end
redis.call('HSET', KEYS[3], message_id, raw)
redis.call('ZADD', KEYS[4], ARGV[2], message_id)
return {raw, message_id}
"""
    _ACK_SCRIPT = """
-- zhixin_queue_ack_v1
local current = redis.call('HGET', KEYS[2], ARGV[1])
if not current or current ~= ARGV[2] then return 0 end
redis.call('LREM', KEYS[1], 1, current)
redis.call('HDEL', KEYS[2], ARGV[1])
redis.call('ZREM', KEYS[3], ARGV[1])
return 1
"""
    _TRANSITION_SCRIPT = """
-- zhixin_queue_transition_v1
local current = redis.call('HGET', KEYS[2], ARGV[1])
if not current or current ~= ARGV[2] then return 0 end
redis.call('LREM', KEYS[1], 1, current)
redis.call('HDEL', KEYS[2], ARGV[1])
redis.call('ZREM', KEYS[3], ARGV[1])
redis.call('LPUSH', KEYS[4], ARGV[3])
return 1
"""

    def __init__(
        self,
        *,
        lease_seconds: float | None = None,
        max_attempts: int | None = None,
        poll_interval: float | None = None,
        socket_timeout: float | None = None,
        socket_connect_timeout: float | None = None,
        time_fn: Callable[[], float] = time.time,
    ) -> None:
        settings = get_settings()
        self.redis_url = settings.redis_url
        self.prefix = "zhixin:queue"
        self.lease_seconds = max(float(lease_seconds or getattr(settings, "queue_lease_seconds", 300.0)), 1.0)
        self.max_attempts = max(int(max_attempts or getattr(settings, "queue_max_attempts", 3)), 1)
        self.poll_interval = max(float(poll_interval or getattr(settings, "queue_poll_interval", 0.1)), 0.01)
        self.socket_timeout = max(
            float(socket_timeout if socket_timeout is not None else getattr(settings, "redis_socket_timeout_seconds", 10.0)),
            0.0,
        )
        self.socket_connect_timeout = max(
            float(
                socket_connect_timeout
                if socket_connect_timeout is not None
                else getattr(settings, "redis_socket_connect_timeout_seconds", 5.0)
            ),
            0.0,
        )
        self.time_fn = time_fn
        self._client: redis.Redis | None = None

    def client(self) -> redis.Redis:
        if self._client is None:
            # redis-py defaults to no socket timeout, so a Redis that accepts the
            # connection and then stops answering turns every queue call into an
            # unbounded block. Every command here is non-blocking (no BRPOP/BLPOP),
            # so a socket timeout is safe. redis.exceptions.TimeoutError subclasses
            # RedisError, so the existing except clauses already cover it.
            self._client = redis.from_url(
                self.redis_url,
                decode_responses=True,
                protocol=2,
                socket_timeout=self.socket_timeout or None,
                socket_connect_timeout=self.socket_connect_timeout or None,
                socket_keepalive=True,
                health_check_interval=30,
            )
        return self._client

    def _keys(self, queue: str) -> tuple[str, str, str, str, str]:
        ready = f"{self.prefix}:{queue}"
        return (
            ready,
            f"{ready}:processing",
            f"{ready}:processing:data",
            f"{ready}:processing:leases",
            f"{ready}:dead",
        )

    def enqueue(self, queue: str, payload: dict[str, Any]) -> dict[str, Any]:
        message = encode_queue_message(payload, enqueued_at=self.time_fn())
        ready, _, _, _, _ = self._keys(queue)
        try:
            self.client().lpush(ready, message)
            return {"queued": True, "queue": ready}
        except redis.RedisError as error:
            return {"queued": False, "queue": ready, "error": str(error)}

    def reserve(self, queues: list[str], timeout: int = 5) -> QueueMessage | None:
        deadline = time.monotonic() + max(float(timeout), 0.0)
        while True:
            self.reclaim_expired(queues)
            for queue in queues:
                ready, processing, data, leases, _ = self._keys(queue)
                lease_until = self.time_fn() + self.lease_seconds
                try:
                    result = self.client().eval(
                        self._RESERVE_SCRIPT,
                        4,
                        ready,
                        processing,
                        data,
                        leases,
                        str(uuid4()),
                        lease_until,
                    )
                except redis.RedisError:
                    return None
                if result:
                    raw, message_id = result
                    return decode_queue_message(
                        raw,
                        queue=queue,
                        fallback_id=str(message_id),
                        lease_until=lease_until,
                    )
            if timeout <= 0 or time.monotonic() >= deadline:
                return None
            time.sleep(min(self.poll_interval, max(deadline - time.monotonic(), 0.0)))

    def ack(self, message: QueueMessage) -> bool:
        _, processing, data, leases, _ = self._keys(message.queue)
        try:
            return bool(self.client().eval(
                self._ACK_SCRIPT,
                3,
                processing,
                data,
                leases,
                message.message_id,
                message.raw,
            ))
        except redis.RedisError:
            return False

    def nack(self, message: QueueMessage, error: str, *, retryable: bool = True) -> dict[str, Any]:
        ready, processing, data, leases, dead = self._keys(message.queue)
        next_attempt = message.attempt + 1
        raw = encode_queue_message(
            message.payload,
            message_id=message.message_id,
            attempt=next_attempt,
            enqueued_at=message.enqueued_at or self.time_fn(),
            last_error=error,
        )
        target = ready if retryable and next_attempt < self.max_attempts else dead
        try:
            transitioned = bool(self.client().eval(
                self._TRANSITION_SCRIPT,
                4,
                processing,
                data,
                leases,
                target,
                message.message_id,
                message.raw,
                raw,
            ))
        except redis.RedisError:
            return {"requeued": False, "deadLettered": False, "error": "QUEUE_TRANSITION_FAILED"}
        return {
            "requeued": transitioned and target == ready,
            "deadLettered": transitioned and target == dead,
            "attempt": next_attempt,
            "stale": not transitioned,
        }

    def reclaim_expired(self, queues: list[str] | None = None) -> int:
        reclaimed = 0
        for queue in queues or []:
            _, _, data, leases, _ = self._keys(queue)
            try:
                message_ids = self.client().zrangebyscore(leases, "-inf", self.time_fn())
            except redis.RedisError:
                continue
            for message_id in message_ids:
                try:
                    raw = self.client().hget(data, message_id)
                except redis.RedisError:
                    continue
                if not raw:
                    continue
                message = decode_queue_message(
                    raw,
                    queue=queue,
                    fallback_id=str(message_id),
                    lease_until=self.time_fn(),
                )
                result = self.nack(message, "QUEUE_LEASE_EXPIRED")
                if not result.get("stale") and not result.get("error"):
                    reclaimed += 1
        return reclaimed

    def pop(self, queues: list[str], timeout: int = 5) -> tuple[str, dict[str, Any]] | None:
        message = self.reserve(queues, timeout=timeout)
        if not message:
            return None
        self.ack(message)
        return message.queue, message.payload

    def dead_letters(self, queue: str) -> list[QueueMessage]:
        _, _, _, _, dead = self._keys(queue)
        try:
            values = self.client().lrange(dead, 0, -1)
        except redis.RedisError:
            return []
        return [decode_queue_message(raw, queue=queue) for raw in reversed(values)]

    def health(self) -> dict[str, Any]:
        try:
            self.client().ping()
            return {"configured": True, "connected": True, "url": self.redis_url}
        except redis.RedisError as error:
            return {"configured": True, "connected": False, "url": self.redis_url, "error": str(error)}


queue_client = QueueClient()
