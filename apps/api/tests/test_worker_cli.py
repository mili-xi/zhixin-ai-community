import time

from types import SimpleNamespace

from app import worker_cli


class RecordingWatchdog(worker_cli.LoopWatchdog):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.stalls = []

    def _on_stall(self, stalled):
        self.stalls.append(stalled)


class FakeScheduler:
    calls = 0

    def __init__(self, db, queue):
        self.db = db
        self.queue = queue

    def enqueue_media_publication_jobs(self):
        type(self).calls += 1
        return {"mediaPublicationDiscovery": 1}


class ExplodingScheduler:
    def __init__(self, db, queue):
        pass

    def enqueue_media_publication_jobs(self):
        raise RuntimeError("poisoned record")


def test_a_failing_scheduler_tick_is_logged_and_skipped(monkeypatch, capsys):
    """A dead worker stalls every queue, so one bad tick must not end the loop."""
    monkeypatch.setattr(worker_cli, "Scheduler", ExplodingScheduler)

    last_run, result = worker_cli.run_scheduler_if_due(
        db=object(),
        queue=object(),
        enabled=True,
        last_run_at=None,
        interval_seconds=60,
        now=100,
    )

    assert result is None
    assert last_run == 100
    assert "poisoned record" in capsys.readouterr().err


def test_scheduler_runs_initially_and_again_only_after_interval(monkeypatch):
    FakeScheduler.calls = 0
    monkeypatch.setattr(worker_cli, "Scheduler", FakeScheduler)

    last_run, first = worker_cli.run_scheduler_if_due(
        db=object(),
        queue=object(),
        enabled=True,
        last_run_at=None,
        interval_seconds=60,
        now=100,
    )
    unchanged, skipped = worker_cli.run_scheduler_if_due(
        db=object(),
        queue=object(),
        enabled=True,
        last_run_at=last_run,
        interval_seconds=60,
        now=159,
    )
    next_run, second = worker_cli.run_scheduler_if_due(
        db=object(),
        queue=object(),
        enabled=True,
        last_run_at=unchanged,
        interval_seconds=60,
        now=160,
    )

    assert first == {"mediaPublicationDiscovery": 1}
    assert skipped is None
    assert second == {"mediaPublicationDiscovery": 1}
    assert (last_run, unchanged, next_run) == (100, 100, 160)
    assert FakeScheduler.calls == 2


def test_scheduler_stays_disabled_without_schedule_flag(monkeypatch):
    FakeScheduler.calls = 0
    monkeypatch.setattr(worker_cli, "Scheduler", FakeScheduler)

    last_run, result = worker_cli.run_scheduler_if_due(
        db=object(),
        queue=object(),
        enabled=False,
        last_run_at=None,
        interval_seconds=60,
        now=100,
    )

    assert last_run is None
    assert result is None
    assert FakeScheduler.calls == 0


class FakeMaintenanceScheduler:
    calls = 0

    def __init__(self, db, queue):
        self.db = db
        self.queue = queue

    def enqueue_desktop_asset_cleanup(self):
        type(self).calls += 1
        return {"desktopAssetCleanup": 2}

    def cleanup_video_assets(self):
        return 0


class ExplodingMaintenanceScheduler:
    def __init__(self, db, queue):
        pass

    def enqueue_desktop_asset_cleanup(self):
        raise RuntimeError("poisoned record")


def test_maintenance_interval_defaults_to_six_hours(monkeypatch):
    monkeypatch.delenv("ZX_MAINTENANCE_INTERVAL_SECONDS", raising=False)
    assert worker_cli.maintenance_interval_seconds() == 6 * 3600.0


def test_maintenance_interval_reads_env(monkeypatch):
    monkeypatch.setenv("ZX_MAINTENANCE_INTERVAL_SECONDS", "900")
    assert worker_cli.maintenance_interval_seconds() == 900.0


def test_maintenance_interval_zero_disables(monkeypatch):
    monkeypatch.setenv("ZX_MAINTENANCE_INTERVAL_SECONDS", "0")
    assert worker_cli.maintenance_interval_seconds() == 0.0


def test_maintenance_interval_bad_value_falls_back_to_default(monkeypatch):
    # A typo must not silently disable a cleanup nobody is watching.
    monkeypatch.setenv("ZX_MAINTENANCE_INTERVAL_SECONDS", "soon")
    assert worker_cli.maintenance_interval_seconds() == 6 * 3600.0


def test_maintenance_runs_initially_and_again_only_after_interval(monkeypatch):
    FakeMaintenanceScheduler.calls = 0
    monkeypatch.setattr(worker_cli, "Scheduler", FakeMaintenanceScheduler)

    last_run, first = worker_cli.run_maintenance_if_due(
        db=object(),
        queue=object(),
        enabled=True,
        last_run_at=None,
        interval_seconds=6 * 3600,
        now=100,
    )
    unchanged, skipped = worker_cli.run_maintenance_if_due(
        db=object(),
        queue=object(),
        enabled=True,
        last_run_at=last_run,
        interval_seconds=6 * 3600,
        now=100 + 6 * 3600 - 1,
    )
    next_run, second = worker_cli.run_maintenance_if_due(
        db=object(),
        queue=object(),
        enabled=True,
        last_run_at=unchanged,
        interval_seconds=6 * 3600,
        now=100 + 6 * 3600,
    )

    assert first == {"desktopAssetCleanup": 2}
    assert skipped is None
    assert second == {"desktopAssetCleanup": 2}
    assert (last_run, unchanged, next_run) == (100, 100, 100 + 6 * 3600)
    assert FakeMaintenanceScheduler.calls == 2


def test_maintenance_stays_disabled_without_schedule_flag(monkeypatch):
    FakeMaintenanceScheduler.calls = 0
    monkeypatch.setattr(worker_cli, "Scheduler", FakeMaintenanceScheduler)

    last_run, result = worker_cli.run_maintenance_if_due(
        db=object(),
        queue=object(),
        enabled=False,
        last_run_at=None,
        interval_seconds=6 * 3600,
        now=100,
    )

    assert last_run is None
    assert result is None
    assert FakeMaintenanceScheduler.calls == 0


def test_maintenance_interval_zero_skips_the_tick(monkeypatch):
    FakeMaintenanceScheduler.calls = 0
    monkeypatch.setattr(worker_cli, "Scheduler", FakeMaintenanceScheduler)

    last_run, result = worker_cli.run_maintenance_if_due(
        db=object(),
        queue=object(),
        enabled=True,
        last_run_at=None,
        interval_seconds=0,
        now=100,
    )

    assert last_run is None
    assert result is None
    assert FakeMaintenanceScheduler.calls == 0


def test_a_failing_maintenance_tick_is_logged_and_skipped(monkeypatch, capsys):
    """A dead worker stalls every queue, so one bad tick must not end the loop."""
    monkeypatch.setattr(worker_cli, "Scheduler", ExplodingMaintenanceScheduler)

    last_run, result = worker_cli.run_maintenance_if_due(
        db=object(),
        queue=object(),
        enabled=True,
        last_run_at=None,
        interval_seconds=6 * 3600,
        now=100,
    )

    assert result is None
    assert last_run == 100
    assert "poisoned record" in capsys.readouterr().err


def test_watchdog_budget_defaults_to_1800(monkeypatch):
    monkeypatch.delenv("ZX_WORKER_WATCHDOG_SECONDS", raising=False)
    assert worker_cli.watchdog_budget_seconds() == 1800.0


def test_watchdog_budget_reads_env(monkeypatch):
    monkeypatch.setenv("ZX_WORKER_WATCHDOG_SECONDS", "600")
    assert worker_cli.watchdog_budget_seconds() == 600.0


def test_watchdog_budget_zero_disables(monkeypatch):
    monkeypatch.setenv("ZX_WORKER_WATCHDOG_SECONDS", "0")
    assert worker_cli.watchdog_budget_seconds() == 0.0


def test_watchdog_budget_bad_value_falls_back_to_default(monkeypatch):
    monkeypatch.setenv("ZX_WORKER_WATCHDOG_SECONDS", "not-a-number")
    assert worker_cli.watchdog_budget_seconds() == 1800.0


def test_watchdog_tick_resets_stall_clock():
    watchdog = worker_cli.LoopWatchdog(1800.0, poll_seconds=5.0)
    time.sleep(0.05)
    before = watchdog.stalled_seconds()
    watchdog.tick()
    assert watchdog.stalled_seconds() < before


def test_watchdog_disabled_budget_starts_no_thread():
    watchdog = worker_cli.LoopWatchdog(0.0, poll_seconds=0.01).start()
    assert watchdog._thread is None


def test_watchdog_fires_when_loop_stops_ticking():
    watchdog = RecordingWatchdog(0.2, poll_seconds=0.02).start()
    time.sleep(0.4)
    assert len(watchdog.stalls) == 1
    assert watchdog.stalls[0] > 0.2


def test_watchdog_stays_quiet_while_loop_ticks():
    watchdog = RecordingWatchdog(10.0, poll_seconds=0.02).start()
    deadline = time.monotonic() + 0.4
    while time.monotonic() < deadline:
        watchdog.tick()
        time.sleep(0.02)
    assert watchdog.stalls == []


class FakeClock:
    def __init__(self, value=1_700_000_000.0):
        self.value = value

    def __call__(self):
        return self.value

    def advance(self, seconds):
        self.value += seconds


def test_heartbeat_path_falls_back_to_the_default(monkeypatch):
    monkeypatch.delenv(worker_cli.HEARTBEAT_PATH_ENV, raising=False)
    assert worker_cli.heartbeat_path() == worker_cli.HEARTBEAT_DEFAULT_PATH
    monkeypatch.setenv(worker_cli.HEARTBEAT_PATH_ENV, "   ")
    assert worker_cli.heartbeat_path() == worker_cli.HEARTBEAT_DEFAULT_PATH
    monkeypatch.setenv(worker_cli.HEARTBEAT_PATH_ENV, "/tmp/custom-worker-heartbeat")
    assert worker_cli.heartbeat_path() == "/tmp/custom-worker-heartbeat"


def test_heartbeat_staleness_reads_env_and_tolerates_bad_values(monkeypatch):
    monkeypatch.delenv(worker_cli.HEARTBEAT_STALENESS_ENV, raising=False)
    assert worker_cli.heartbeat_staleness_seconds() == worker_cli.HEARTBEAT_DEFAULT_STALENESS_SECONDS
    monkeypatch.setenv(worker_cli.HEARTBEAT_STALENESS_ENV, "120")
    assert worker_cli.heartbeat_staleness_seconds() == 120.0
    monkeypatch.setenv(worker_cli.HEARTBEAT_STALENESS_ENV, "0")
    assert worker_cli.heartbeat_staleness_seconds() == 0.0
    monkeypatch.setenv(worker_cli.HEARTBEAT_STALENESS_ENV, "not-a-number")
    assert worker_cli.heartbeat_staleness_seconds() == worker_cli.HEARTBEAT_DEFAULT_STALENESS_SECONDS


def test_loop_heartbeat_writes_a_stamp_and_throttles_between_writes(tmp_path):
    clock = FakeClock()
    target = tmp_path / "worker-heartbeat"
    heartbeat = worker_cli.LoopHeartbeat(str(target), interval_seconds=5.0, time_fn=clock)

    assert heartbeat.tick() is True
    assert worker_cli.read_loop_heartbeat(str(target)) == clock.value

    clock.advance(4.0)
    assert heartbeat.tick() is False

    clock.advance(2.0)
    assert heartbeat.tick() is True
    assert worker_cli.read_loop_heartbeat(str(target)) == clock.value

    clock.advance(1.0)
    assert heartbeat.tick(force=True) is True


def test_loop_heartbeat_swallows_write_failures(tmp_path):
    # A directory cannot be opened for writing, and an unwritable heartbeat must
    # never be the reason the worker dies.
    heartbeat = worker_cli.LoopHeartbeat(str(tmp_path), interval_seconds=0.0)

    assert heartbeat.tick() is False


def test_read_loop_heartbeat_returns_none_for_missing_or_broken_files(tmp_path):
    assert worker_cli.read_loop_heartbeat(str(tmp_path / "absent")) is None
    broken = tmp_path / "broken-heartbeat"
    broken.write_text("not-a-timestamp\n", encoding="utf-8")
    assert worker_cli.read_loop_heartbeat(str(broken)) is None


def stub_queue_health(monkeypatch, health):
    monkeypatch.setattr(worker_cli, "queue_client", SimpleNamespace(health=health))


def test_worker_health_probe_reports_unhealthy_without_a_heartbeat_file(tmp_path, monkeypatch):
    monkeypatch.setenv(worker_cli.HEARTBEAT_PATH_ENV, str(tmp_path / "worker-heartbeat"))
    stub_queue_health(monkeypatch, lambda: {"connected": True})

    assert worker_cli.worker_health_probe() == 1


def test_worker_health_probe_reports_healthy_with_a_fresh_heartbeat(tmp_path, monkeypatch):
    target = tmp_path / "worker-heartbeat"
    target.write_text(f"{time.time():.3f}\n", encoding="utf-8")
    monkeypatch.setenv(worker_cli.HEARTBEAT_PATH_ENV, str(target))
    stub_queue_health(monkeypatch, lambda: {"connected": True})

    assert worker_cli.worker_health_probe() == 0


def test_worker_health_probe_reports_unhealthy_with_a_stale_heartbeat(tmp_path, monkeypatch):
    target = tmp_path / "worker-heartbeat"
    target.write_text(f"{time.time() - 1200:.3f}\n", encoding="utf-8")
    monkeypatch.setenv(worker_cli.HEARTBEAT_PATH_ENV, str(target))
    stub_queue_health(monkeypatch, lambda: {"connected": True})

    assert worker_cli.worker_health_probe() == 1


def test_worker_health_probe_honours_the_staleness_override(tmp_path, monkeypatch):
    target = tmp_path / "worker-heartbeat"
    target.write_text(f"{time.time() - 120:.3f}\n", encoding="utf-8")
    monkeypatch.setenv(worker_cli.HEARTBEAT_PATH_ENV, str(target))
    monkeypatch.setenv(worker_cli.HEARTBEAT_STALENESS_ENV, "60")
    stub_queue_health(monkeypatch, lambda: {"connected": True})

    assert worker_cli.worker_health_probe() == 1

    monkeypatch.setenv(worker_cli.HEARTBEAT_STALENESS_ENV, "600")
    assert worker_cli.worker_health_probe() == 0


def test_worker_health_probe_can_skip_the_heartbeat_entirely(tmp_path, monkeypatch):
    monkeypatch.setenv(worker_cli.HEARTBEAT_PATH_ENV, str(tmp_path / "absent"))
    stub_queue_health(monkeypatch, lambda: {"connected": True})

    assert worker_cli.worker_health_probe(0) == 0


def test_worker_health_probe_reports_unhealthy_when_redis_is_down(tmp_path, monkeypatch):
    monkeypatch.setenv(worker_cli.HEARTBEAT_PATH_ENV, str(tmp_path / "worker-heartbeat"))
    stub_queue_health(monkeypatch, lambda: {"connected": False})

    assert worker_cli.worker_health_probe() == 1


def test_worker_health_probe_treats_a_throwing_health_check_as_unhealthy(tmp_path, monkeypatch):
    monkeypatch.setenv(worker_cli.HEARTBEAT_PATH_ENV, str(tmp_path / "worker-heartbeat"))

    def exploding_health():
        raise RuntimeError("redis unreachable")

    stub_queue_health(monkeypatch, exploding_health)

    assert worker_cli.worker_health_probe() == 1
