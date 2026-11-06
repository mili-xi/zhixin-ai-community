from __future__ import annotations

import argparse
import faulthandler
import os
import sys
import threading
import time

from .database import SessionLocal, init_db
from .queue import queue_client
from .service import normalize_legacy_index_submissions
from .worker import Scheduler, TaskExecutor


WATCHDOG_DEFAULT_BUDGET_SECONDS = 1800.0
WATCHDOG_DEFAULT_POLL_SECONDS = 15.0
HEARTBEAT_PATH_ENV = "ZX_WORKER_HEARTBEAT_PATH"
HEARTBEAT_DEFAULT_PATH = "/tmp/zhixin-ai-worker-heartbeat"
HEARTBEAT_DEFAULT_INTERVAL_SECONDS = 5.0
HEARTBEAT_STALENESS_ENV = "ZX_WORKER_HEARTBEAT_MAX_STALENESS_SECONDS"
HEARTBEAT_DEFAULT_STALENESS_SECONDS = 900.0
MAINTENANCE_DEFAULT_INTERVAL_SECONDS = 6 * 3600.0
MAINTENANCE_INTERVAL_ENV = "ZX_MAINTENANCE_INTERVAL_SECONDS"


def watchdog_budget_seconds() -> float:
    """Read the stall budget from ZX_WORKER_WATCHDOG_SECONDS (0 disables).

    The queue lease is 300s, so a loop iteration still running after 30 minutes is
    wedged rather than slow. Defaults to 1800s; a bad value falls back to the
    default instead of silently disabling the watchdog.
    """
    raw = (os.environ.get("ZX_WORKER_WATCHDOG_SECONDS") or "").strip()
    if not raw:
        return WATCHDOG_DEFAULT_BUDGET_SECONDS
    try:
        value = float(raw)
    except ValueError:
        return WATCHDOG_DEFAULT_BUDGET_SECONDS
    return value if value > 0 else 0.0


def heartbeat_path() -> str:
    return (os.environ.get(HEARTBEAT_PATH_ENV) or "").strip() or HEARTBEAT_DEFAULT_PATH


def heartbeat_staleness_seconds() -> float:
    raw = (os.environ.get(HEARTBEAT_STALENESS_ENV) or "").strip()
    if not raw:
        return HEARTBEAT_DEFAULT_STALENESS_SECONDS
    try:
        value = float(raw)
    except ValueError:
        return HEARTBEAT_DEFAULT_STALENESS_SECONDS
    return value if value > 0 else 0.0


def maintenance_interval_seconds() -> float:
    """Read the desktop asset cleanup cadence from ZX_MAINTENANCE_INTERVAL_SECONDS.

    0 disables the sweep; a bad value falls back to the default rather than
    silently disabling a cleanup nobody is watching.
    """
    raw = (os.environ.get(MAINTENANCE_INTERVAL_ENV) or "").strip()
    if not raw:
        return MAINTENANCE_DEFAULT_INTERVAL_SECONDS
    try:
        value = float(raw)
    except ValueError:
        return MAINTENANCE_DEFAULT_INTERVAL_SECONDS
    return value if value > 0 else 0.0


class LoopHeartbeat:
    """Publishes main-loop liveness as a timestamp file for the healthcheck.

    Written by the loop itself, never by the watchdog thread: a wedged loop keeps
    the watchdog thread alive, so a heartbeat written from there would stay fresh
    exactly when it needs to go stale. Write failures are swallowed on purpose --
    observability must not be able to take the worker down.
    """

    def __init__(
        self,
        path: str,
        *,
        interval_seconds: float = HEARTBEAT_DEFAULT_INTERVAL_SECONDS,
        time_fn=time.time,
    ) -> None:
        self.path = path
        self.interval_seconds = max(float(interval_seconds), 0.0)
        self.time_fn = time_fn
        self._last_write = float("-inf")

    def tick(self, *, force: bool = False) -> bool:
        now = self.time_fn()
        if not force and now - self._last_write < self.interval_seconds:
            return False
        try:
            with open(self.path, "w", encoding="utf-8") as handle:
                handle.write(f"{now:.3f}\n")
        except OSError:
            return False
        self._last_write = now
        return True


def read_loop_heartbeat(path: str | None = None) -> float | None:
    target = path or heartbeat_path()
    try:
        with open(target, "r", encoding="utf-8") as handle:
            return float(handle.read().strip())
    except (OSError, ValueError):
        return None


def worker_health_probe(max_staleness_seconds: float | None = None) -> int:
    """Exit-code helper for the container healthcheck: 0 healthy, 1 unhealthy.

    Covers both halves the old Redis-only probe missed -- that Redis answers, and
    that the main loop is still ticking. Docker does not restart an unhealthy
    container on its own, so this is a detection signal for operators and
    monitoring, while LoopWatchdog remains the recovery mechanism.
    """
    try:
        if not queue_client.health().get("connected"):
            return 1
    except Exception:
        return 1
    staleness = heartbeat_staleness_seconds() if max_staleness_seconds is None else max(float(max_staleness_seconds), 0.0)
    if staleness <= 0:
        return 0
    stamp = read_loop_heartbeat()
    if stamp is None:
        return 1
    return 1 if time.time() - stamp > staleness else 0


class LoopWatchdog:
    """Kills the worker when the main loop stops making progress.

    Every unbounded blocking call in the dependency stack (browser protocol,
    database, HTTP) can only be fixed one at a time. This is the backstop: if the
    loop ever stops ticking again, the process dies loudly with a traceback in the
    log, Docker restarts it, and the expired lease lets the queue retry or
    dead-letter the task instead of stalling every queue forever.
    """

    def __init__(
        self,
        budget_seconds: float,
        *,
        poll_seconds: float = WATCHDOG_DEFAULT_POLL_SECONDS,
    ) -> None:
        self.budget_seconds = float(budget_seconds)
        self.poll_seconds = max(float(poll_seconds), 0.01)
        self._last_tick = time.monotonic()
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None

    def tick(self) -> None:
        with self._lock:
            self._last_tick = time.monotonic()

    def stalled_seconds(self) -> float:
        with self._lock:
            return time.monotonic() - self._last_tick

    def _on_stall(self, stalled: float) -> None:
        faulthandler.dump_traceback(file=sys.stderr)
        sys.stderr.write(
            f"[watchdog] main loop stalled for {stalled:.0f}s "
            f"(budget {self.budget_seconds:.0f}s); exiting for restart\n"
        )
        sys.stderr.flush()
        os._exit(70)

    def _run(self) -> None:
        while True:
            time.sleep(self.poll_seconds)
            stalled = self.stalled_seconds()
            if stalled > self.budget_seconds:
                self._on_stall(stalled)
                return

    def start(self) -> "LoopWatchdog":
        if self.budget_seconds <= 0:
            return self
        self._thread = threading.Thread(
            target=self._run, name="worker-loop-watchdog", daemon=True
        )
        self._thread.start()
        return self


def run_scheduler_if_due(
    db,
    queue,
    enabled: bool,
    last_run_at: float | None,
    interval_seconds: float,
    now: float | None = None,
) -> tuple[float | None, dict | None]:
    if not enabled:
        return last_run_at, None
    current = time.monotonic() if now is None else now
    interval = max(float(interval_seconds), 1.0)
    if last_run_at is not None and current - last_run_at < interval:
        return last_run_at, None
    try:
        return current, Scheduler(db, queue).enqueue_media_publication_jobs()
    except Exception as error:
        # One poisoned record must not take the loop down: a dead worker stalls
        # every queue, which is a far worse failure than a skipped tick. The
        # traceback still lands in the log, so the cause is not lost.
        sys.stderr.write(f"[scheduler] enqueue failed: {error}\n")
        sys.stderr.flush()
        return current, None


def run_maintenance_if_due(
    db,
    queue,
    enabled: bool,
    last_run_at: float | None,
    interval_seconds: float,
    now: float | None = None,
) -> tuple[float | None, dict | None]:
    if not enabled:
        return last_run_at, None
    interval = max(float(interval_seconds), 0.0)
    if interval <= 0:
        return last_run_at, None
    current = time.monotonic() if now is None else now
    if last_run_at is not None and current - last_run_at < interval:
        return last_run_at, None
    try:
        scheduler = Scheduler(db, queue)
        desktop_result = scheduler.enqueue_desktop_asset_cleanup()
        scheduler.cleanup_video_assets()
        # Preserve the existing desktop cleanup result contract.
        return current, desktop_result
    except Exception as error:
        # Same contract as the scheduler tick: one bad row must not stall the
        # loop, and the traceback still lands in the log.
        sys.stderr.write(f"[maintenance] desktop asset cleanup enqueue failed: {error}\n")
        sys.stderr.flush()
        return current, None


def main() -> None:
    parser = argparse.ArgumentParser(description="Zhixin AI background worker")
    parser.add_argument("--queues", default="default,publish,index,media,knowledge,seo,ai", help="Comma separated queue names")
    parser.add_argument("--once", action="store_true", help="Process at most one task")
    parser.add_argument("--schedule", action="store_true", help="Enqueue scheduled jobs before consuming")
    parser.add_argument("--schedule-interval", type=float, default=60.0, help="Seconds between media publication monitoring runs")
    parser.add_argument("--maintenance-interval", type=float, default=None, help="Seconds between desktop asset cleanup sweeps (0 disables, defaults to ZX_MAINTENANCE_INTERVAL_SECONDS)")
    parser.add_argument("--sleep", type=float, default=1.0, help="Idle sleep seconds")
    args = parser.parse_args()
    maintenance_interval = (
        args.maintenance_interval if args.maintenance_interval is not None
        else maintenance_interval_seconds()
    )

    init_db()
    queues = [item.strip() for item in args.queues.split(",") if item.strip()]
    with SessionLocal() as db:
        normalize_legacy_index_submissions(db)
        executor = TaskExecutor(db, queue_client)
        watchdog = LoopWatchdog(watchdog_budget_seconds()).start()
        heartbeat = LoopHeartbeat(heartbeat_path())
        last_schedule_at: float | None = None
        last_maintenance_at: float | None = None
        if args.schedule:
            try:
                Scheduler(db, queue_client).enqueue_due_jobs()
            except Exception as error:
                sys.stderr.write(f"[scheduler] startup enqueue failed: {error}\n")
                sys.stderr.flush()
            last_schedule_at = time.monotonic()
            # The startup sweep already ran the cleanup once, so the periodic
            # maintenance tick starts from the same clock as the scheduler.
            last_maintenance_at = time.monotonic()
        last_reconciliation_at = 0.0
        while True:
            if time.monotonic() - last_reconciliation_at >= 60:
                from .queue_reconciliation import reconcile_queue_state
                try:
                    reconcile_queue_state(db, queue_client, queues)
                except Exception as error:
                    db.rollback()
                    sys.stderr.write(f"[reconciliation] failed: {error}\n")
                last_reconciliation_at = time.monotonic()
            watchdog.tick()
            heartbeat.tick()
            last_schedule_at, _ = run_scheduler_if_due(
                db,
                queue_client,
                args.schedule,
                last_schedule_at,
                args.schedule_interval,
            )
            last_maintenance_at, _ = run_maintenance_if_due(
                db,
                queue_client,
                args.schedule,
                last_maintenance_at,
                maintenance_interval,
            )
            processed = executor.run_next(queues, timeout=5)
            if args.once:
                break
            if not processed:
                time.sleep(args.sleep)


if __name__ == "__main__":
    main()
