import logging
import signal
import threading
from collections.abc import Callable

from swayambhu_worker.config import WorkerSettings

log = logging.getLogger("swayambhu_worker")

# A job handler claims and runs at most one job, returning True if it did any work.
# The job queue itself is undecided (decisions log Q-18), so the default does nothing.
JobHandler = Callable[[], bool]


def no_queue_configured() -> bool:
    return False


def run(settings: WorkerSettings, handle_one: JobHandler, stop: threading.Event) -> int:
    """Poll for jobs until `stop` is set. Returns the number of jobs handled."""
    handled = 0
    while not stop.is_set():
        if handle_one():
            handled += 1
            continue
        stop.wait(settings.poll_interval_seconds)
    return handled


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    log.info("worker started; no job queue configured yet (Q-18)")
    run(WorkerSettings(), no_queue_configured, stop)
    log.info("worker stopped")


if __name__ == "__main__":
    main()
