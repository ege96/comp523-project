"""Embedding search queries (D-012).

Stored chunks are embedded by the worker; this embeds the visitor's query with the same
model so the vectors are comparable. The worker has the same providers in
`swayambhu_worker.providers`; keep `name` and the fake vectors identical in both, because
search only matches chunk_embeddings rows whose `model` equals `Embedder.name`. A mismatch
then returns no semantic hits rather than wrong ones.
"""

import hashlib
import math
from typing import Protocol

import httpx2 as httpx

from swayambhu_api.config import Settings

OPENAI_BASE_URL = "https://api.openai.com/v1"


class EmbeddingError(Exception):
    """The provider failed. Search can fall back to keyword results."""


class EmbeddingConfigError(ValueError):
    """The selected provider is missing a setting."""


class QueryEmbedder(Protocol):
    @property
    def name(self) -> str: ...

    def embed_query(self, text: str) -> list[float]: ...


class OpenAIQueryEmbedder:
    def __init__(self, client: httpx.Client, model: str, dimensions: int | None) -> None:
        self._client = client
        self._model = model
        self._dimensions = dimensions

    @property
    def name(self) -> str:
        suffix = f"@{self._dimensions}" if self._dimensions else ""
        return f"openai:{self._model}{suffix}"

    def embed_query(self, text: str) -> list[float]:
        body: dict[str, object] = {"model": self._model, "input": [text]}
        if self._dimensions:
            body["dimensions"] = self._dimensions
        try:
            response = self._client.post("/embeddings", json=body)
        except httpx.HTTPError as exc:
            raise EmbeddingError(f"OpenAI unreachable: {exc}") from exc
        if response.status_code >= 400:
            raise EmbeddingError(f"OpenAI returned {response.status_code}")
        rows = response.json().get("data") or []
        if len(rows) != 1:
            raise EmbeddingError("OpenAI returned no embedding")
        return [float(x) for x in rows[0]["embedding"]]


class FakeQueryEmbedder:
    """Same hash vectors as the worker's FakeEmbedder. Never configure in production."""

    def __init__(self, dimensions: int = 8) -> None:
        self._dimensions = dimensions

    @property
    def name(self) -> str:
        return f"fake:hash@{self._dimensions}"

    def embed_query(self, text: str) -> list[float]:
        digest = hashlib.sha256(text.encode()).digest()
        raw = [digest[i % len(digest)] - 127.5 for i in range(self._dimensions)]
        norm = math.sqrt(sum(x * x for x in raw)) or 1.0
        return [x / norm for x in raw]


def build_query_embedder(settings: Settings) -> QueryEmbedder:
    if settings.embedding_provider == "fake":
        return FakeQueryEmbedder(settings.embedding_dimensions or 8)
    if settings.embedding_model is None:
        raise EmbeddingConfigError("EMBEDDING_MODEL must be set to use the openai provider")
    if settings.openai_api_key is None:
        raise EmbeddingConfigError("OPENAI_API_KEY must be set to use the openai provider")
    client = httpx.Client(
        base_url=OPENAI_BASE_URL,
        headers={"Authorization": f"Bearer {settings.openai_api_key.get_secret_value()}"},
        timeout=settings.embedding_timeout_seconds,
    )
    return OpenAIQueryEmbedder(client, settings.embedding_model, settings.embedding_dimensions)
