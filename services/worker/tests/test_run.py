import threading

import pytest
from swayambhu_providers.factory import ProviderConfigError

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


def test_run_keeps_polling_when_the_database_is_unavailable() -> None:
    stop = threading.Event()
    attempts = []

    def handle_one() -> bool:
        attempts.append(1)
        if len(attempts) == 3:
            stop.set()
        raise ConnectionError("database is starting")

    assert run(WorkerSettings(poll_interval_seconds=0), handle_one, stop) == 0
    assert len(attempts) == 3


def test_run_returns_immediately_when_already_stopped() -> None:
    stop = threading.Event()
    stop.set()
    assert run(WorkerSettings(), lambda: True, stop) == 0


def test_main_builds_the_configured_providers_and_runs(monkeypatch: pytest.MonkeyPatch) -> None:
    for kind in ("TRANSCRIPTION", "TRANSLATION", "EMBEDDING"):
        monkeypatch.setenv(f"{kind}_PROVIDER", "fake")
    calls: list[JobHandler] = []

    def fake_run(_: WorkerSettings, handle_one: JobHandler, stop: threading.Event) -> int:
        calls.append(handle_one)
        return 0

    monkeypatch.setattr(worker_main, "run", fake_run)
    worker_main.main()
    assert len(calls) == 1


def test_main_refuses_to_start_with_a_provider_half_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TRANSCRIPTION_PROVIDER", "openai")
    monkeypatch.delenv("TRANSCRIPTION_MODEL", raising=False)
    with pytest.raises(ProviderConfigError, match="TRANSCRIPTION_MODEL"):
        worker_main.main()
