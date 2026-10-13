import threading

from swayambhu_worker.__main__ import run
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
