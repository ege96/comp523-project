import pytest
from swayambhu_providers.factory import build_embedder

from swayambhu_worker.config import WorkerSettings


def test_worker_reads_the_shared_provider_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EMBEDDING_PROVIDER", "fake")
    monkeypatch.setenv("EMBEDDING_DIMENSIONS", "16")
    assert build_embedder(WorkerSettings()).name == "fake:hash@16"
