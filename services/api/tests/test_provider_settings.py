import pytest
from swayambhu_providers.factory import build_embedder

from swayambhu_api.config import Settings


def test_api_reads_the_shared_provider_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    """The API embeds queries from the same env vars the worker uses for stored chunks."""
    monkeypatch.setenv("EMBEDDING_PROVIDER", "fake")
    monkeypatch.setenv("EMBEDDING_DIMENSIONS", "16")
    assert build_embedder(Settings()).name == "fake:hash@16"
