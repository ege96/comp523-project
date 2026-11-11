"""Swayambhu Stories background worker (FFmpeg, transcription, translation, embeddings)."""

import logging
import signal
import threading
import time
from collections.abc import Callable
from datetime import timedelta

from swayambhu_core.storage import LocalMediaStore
from swayambhu_providers.factory import build_embedder, build_transcriber, build_translator

from swayambhu_worker.cleanup import remove_abandoned_uploads
from swayambhu_worker.config import WorkerSettings
from swayambhu_worker.db import session_factory
from swayambhu_worker.runner import JobRunner
from swayambhu_worker.steps import Providers

log = logging.getLogger("swayambhu_worker")

# A job handler claims and runs at most one job, returning True if it did any work.
JobHandler = Callable[[], bool]


def run(settings: WorkerSettings, handle_one: JobHandler, stop: threading.Event) -> int:
    """Poll for jobs until `stop` is set. Returns the number of jobs handled."""
    handled = 0
    while not stop.is_set():
        try:
            if handle_one():
                handled += 1
                continue
        except Exception:
            # Usually the database: down, restarting, or not migrated yet. Keep polling.
            log.exception("could not check the job queue")
        stop.wait(settings.poll_interval_seconds)
    return handled


def build_runner(settings: WorkerSettings) -> JobRunner:
    """Fails at startup, not mid-job, if a provider's settings are missing."""
    providers = Providers(
        transcriber=build_transcriber(settings),
        translator=build_translator(settings),
        embedder=build_embedder(settings),
    )
    return JobRunner(
        session_factory(settings),
        providers,
        LocalMediaStore(settings.media_root),
        timedelta(seconds=settings.job_lease_seconds),
        media_timeout=timedelta(seconds=settings.media_timeout_seconds),
    )


def with_upload_cleanup(settings: WorkerSettings, handle_one: JobHandler) -> JobHandler:
    """Sweep abandoned uploads at most once an hour, between jobs."""
    next_sweep = 0.0

    def handle() -> bool:
        nonlocal next_sweep
        if time.monotonic() >= next_sweep:
            next_sweep = time.monotonic() + 3600
            remove_abandoned_uploads(
                settings.media_root / "uploads", timedelta(days=settings.upload_retention_days)
            )
        return handle_one()

    return handle


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    settings = WorkerSettings()
    runner = build_runner(settings)
    log.info("worker started")
    run(settings, with_upload_cleanup(settings, runner.handle_one), stop)
    log.info("worker stopped")


if __name__ == "__main__":
    main()
