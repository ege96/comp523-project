import json

import httpx2 as httpx
import pytest
from pydantic import SecretStr

from swayambhu_api.config import Settings
from swayambhu_api.embeddings import (
    EmbeddingConfigError,
    EmbeddingError,
    FakeQueryEmbedder,
    OpenAIQueryEmbedder,
    build_query_embedder,
)


def client(handler: object) -> httpx.Client:
    return httpx.Client(base_url="https://example.test", transport=httpx.MockTransport(handler))  # type: ignore[arg-type]


def test_openai_query_embedding() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.read())
        assert body == {"model": "embed-model", "input": ["dawn rituals"], "dimensions": 64}
        return httpx.Response(200, json={"data": [{"index": 0, "embedding": [0.5, 0.25]}]})

    embedder = OpenAIQueryEmbedder(client(handler), "embed-model", 64)
    assert embedder.embed_query("dawn rituals") == [0.5, 0.25]
    assert embedder.name == "openai:embed-model@64"


@pytest.mark.parametrize("status", [429, 500, 401])
def test_openai_errors_raise_embedding_error(status: int) -> None:
    embedder = OpenAIQueryEmbedder(client(lambda _: httpx.Response(status)), "m", None)
    with pytest.raises(EmbeddingError):
        embedder.embed_query("q")


def test_fake_embedder_matches_the_worker_algorithm() -> None:
    """Pinned so the API's fake stays identical to swayambhu_worker's FakeEmbedder."""
    vector = FakeQueryEmbedder(4).embed_query("x")
    # Same pinned value as services/worker/tests/test_providers.py.
    assert [round(v, 6) for v in vector] == [-0.557115, -0.097917, -0.712431, -0.415304]


def test_factory() -> None:
    fake = build_query_embedder(Settings(embedding_provider="fake", embedding_dimensions=16))
    assert fake.name == "fake:hash@16"
    real = build_query_embedder(
        Settings(embedding_model="embed-model", openai_api_key=SecretStr("k"))
    )
    assert real.name == "openai:embed-model"
    with pytest.raises(EmbeddingConfigError, match="EMBEDDING_MODEL"):
        build_query_embedder(Settings(embedding_model=None))
    with pytest.raises(EmbeddingConfigError, match="OPENAI_API_KEY"):
        build_query_embedder(Settings(embedding_model="m", openai_api_key=None))
