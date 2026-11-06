import json

from app.queue import MemoryQueueClient, QueueClient, decode_queue_message


class Clock:
    def __init__(self, value=1_000.0):
        self.value = value

    def __call__(self):
        return self.value

    def advance(self, seconds):
        self.value += seconds


def test_reserve_keeps_message_in_processing_until_ack():
    queue = MemoryQueueClient(lease_seconds=30)
    queue.enqueue("ai", {"taskId": "task-1"})

    message = queue.reserve(["ai"], timeout=0)

    assert message.payload == {"taskId": "task-1"}
    assert queue.ready_count("ai") == 0
    assert queue.processing_count("ai") == 1
    assert queue.ack(message) is True
    assert queue.processing_count("ai") == 0


def test_nack_requeues_with_incremented_attempt():
    queue = MemoryQueueClient(max_attempts=3)
    queue.enqueue("media", {"taskId": "task-retry"})
    first = queue.reserve(["media"], timeout=0)

    result = queue.nack(first, "temporary failure")
    second = queue.reserve(["media"], timeout=0)

    assert result["requeued"] is True
    assert second.message_id == first.message_id
    assert second.attempt == 1
    assert second.payload == first.payload


def test_expired_lease_is_reclaimed_after_worker_crash():
    clock = Clock()
    queue = MemoryQueueClient(lease_seconds=10, max_attempts=3, time_fn=clock)
    queue.enqueue("publish", {"taskId": "task-crash"})
    first = queue.reserve(["publish"], timeout=0)

    clock.advance(11)
    assert queue.reclaim_expired(["publish"]) == 1
    recovered = queue.reserve(["publish"], timeout=0)

    assert recovered.message_id == first.message_id
    assert recovered.attempt == 1
    assert queue.processing_count("publish") == 1


def test_retry_exhaustion_moves_message_to_dead_letter_queue():
    queue = MemoryQueueClient(max_attempts=2)
    queue.enqueue("seo", {"taskId": "task-dead"})

    first = queue.reserve(["seo"], timeout=0)
    queue.nack(first, "first failure")
    second = queue.reserve(["seo"], timeout=0)
    result = queue.nack(second, "second failure")

    assert result["deadLettered"] is True
    assert queue.reserve(["seo"], timeout=0) is None
    dead = queue.dead_letters("seo")
    assert len(dead) == 1
    assert dead[0].payload == {"taskId": "task-dead"}
    assert dead[0].attempt == 2
    assert dead[0].last_error == "second failure"


def test_legacy_bare_json_payload_is_decoded_without_data_loss():
    raw = json.dumps({"taskId": "legacy-task", "type": "demo"})

    decoded = decode_queue_message(raw, queue="default", fallback_id="legacy-1", lease_until=123.0)

    assert decoded.message_id == "legacy-1"
    assert decoded.payload == {"taskId": "legacy-task", "type": "demo"}
    assert decoded.attempt == 0
    assert decoded.lease_until == 123.0

def capture_from_url_kwargs(monkeypatch):
    from app import queue as queue_module

    captured: dict = {}

    def fake_from_url(url, **kwargs):
        captured["url"] = url
        captured.update(kwargs)
        return "redis-client-stub"

    monkeypatch.setattr(queue_module.redis, "from_url", fake_from_url)
    return captured


def test_queue_client_passes_socket_timeouts_to_redis(monkeypatch):
    captured = capture_from_url_kwargs(monkeypatch)

    client = QueueClient(socket_timeout=7.0, socket_connect_timeout=3.0)

    assert client.client() == "redis-client-stub"
    assert captured["socket_timeout"] == 7.0
    assert captured["socket_connect_timeout"] == 3.0
    assert captured["socket_keepalive"] is True
    assert captured["health_check_interval"] == 30


def test_queue_client_reads_socket_timeouts_from_settings(monkeypatch):
    from app import queue as queue_module
    from app.config import Settings

    captured = capture_from_url_kwargs(monkeypatch)
    monkeypatch.setattr(queue_module, "get_settings", lambda: Settings(
        database_url="sqlite://",
        redis_socket_timeout_seconds=4.0,
        redis_socket_connect_timeout_seconds=2.0,
    ))

    client = QueueClient()
    client.client()

    assert captured["socket_timeout"] == 4.0
    assert captured["socket_connect_timeout"] == 2.0


def test_queue_client_zero_socket_timeout_keeps_the_library_default(monkeypatch):
    captured = capture_from_url_kwargs(monkeypatch)

    client = QueueClient(socket_timeout=0.0, socket_connect_timeout=0.0)
    client.client()

    assert captured["socket_timeout"] is None
    assert captured["socket_connect_timeout"] is None


def test_queue_client_clamps_negative_socket_timeouts(monkeypatch):
    captured = capture_from_url_kwargs(monkeypatch)

    client = QueueClient(socket_timeout=-5.0, socket_connect_timeout=-1.0)
    client.client()

    assert captured["socket_timeout"] is None
    assert captured["socket_connect_timeout"] is None