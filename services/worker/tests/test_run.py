import threading

import pytest

import swayambhu_worker.__main__ as worker_main
from swayambhu_worker.__main__ import JobHandler, run
from swayambhu_worker.config import WorkerSettings


def test_run_drains_jobs_then_stops() -> None:
    jobs = [1, 2, 3]
    stop = threading.Event()

    def handle_one() -> bool:
        if jobs:
            jobs.pop()
            return True
        stop.set()
        return False

    handled = run(WorkerSettings(poll_interval_seconds=0), handle_one, stop)
    assert handled == 3


def test_run_returns_immediately_when_already_stopped() -> None:
    stop = threading.Event()
    stop.set()
    assert run(WorkerSettings(), lambda: True, stop) == 0


def test_main_runs_with_no_queue_until_stopped(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[JobHandler] = []

    def fake_run(_: WorkerSettings, handle_one: JobHandler, stop: threading.Event) -> int:
        calls.append(handle_one)
        return 0

    monkeypatch.setattr(worker_main, "run", fake_run)
    worker_main.main()
    assert calls == [worker_main.no_queue_configured]
    assert worker_main.no_queue_configured() is False
