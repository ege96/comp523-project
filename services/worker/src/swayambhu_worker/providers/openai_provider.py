"""OpenAI transcription and embeddings over the REST API (D-012, D-013).

Verify model names, request limits and supported languages against OpenAI's docs before
production use; they change often.
"""

from collections.abc import Sequence

import httpx2 as httpx

from swayambhu_worker.providers import (
    AudioClip,
    EmbeddingKind,
    ProviderError,
    TranscribedSegment,
    raise_for_status,
)

OPENAI_BASE_URL = "https://api.openai.com/v1"


def _post(client: httpx.Client, path: str, **kwargs: object) -> dict[str, object]:
    try:
        response = client.post(path, **kwargs)  # type: ignore[arg-type]
    except httpx.TimeoutException as exc:
        raise ProviderError(f"OpenAI timed out: {exc}", retryable=True) from exc
    except httpx.TransportError as exc:
        raise ProviderError(f"OpenAI unreachable: {exc}", retryable=True) from exc
    raise_for_status(response.status_code, response.text, "OpenAI")
    data: dict[str, object] = response.json()
    return data


def openai_client(
    api_key: str, base_url: str = OPENAI_BASE_URL, timeout: float = 120
) -> httpx.Client:
    return httpx.Client(
        base_url=base_url, headers={"Authorization": f"Bearer {api_key}"}, timeout=timeout
    )


class OpenAITranscriber:
    """Transcribes one clip into one segment spanning the clip.

    The clip boundaries are the timestamps, so this works whether or not the model returns
    its own timestamps.
    """

    def __init__(self, client: httpx.Client, model: str) -> None:
        self._client = client
        self._model = model

    @property
    def name(self) -> str:
        return f"openai:{self._model}"

    def transcribe(
        self, clip: AudioClip, language_hints: Sequence[str]
    ) -> list[TranscribedSegment]:
        form = {"model": self._model, "response_format": "json"}
        # The API takes one ISO 639-1 (two-letter) code. Nepal Bhasa ("new") has none, so
        # the model detects the language itself in that case.
        two_letter = [code for code in language_hints if len(code) == 2]
        if len(two_letter) == 1:
            form["language"] = two_letter[0]
        with clip.path.open("rb") as audio:
            data = _post(
                self._client,
                "/audio/transcriptions",
                data=form,
                files={"file": (clip.path.name, audio)},
            )
        text = str(data.get("text", "")).strip()
        if not text:
            return []
        language = data.get("language")
        return [
            TranscribedSegment(
                start_ms=0,
                end_ms=clip.duration_ms,
                text=text,
                language=language if isinstance(language, str) else None,
            )
        ]


class OpenAIEmbedder:
    def __init__(
        self, client: httpx.Client, model: str, dimensions: int | None, batch_size: int = 100
    ) -> None:
        self._client = client
        self._model = model
        self._dimensions = dimensions
        self._batch_size = batch_size

    @property
    def name(self) -> str:
        suffix = f"@{self._dimensions}" if self._dimensions else ""
        return f"openai:{self._model}{suffix}"

    def embed(self, texts: Sequence[str], kind: EmbeddingKind) -> list[list[float]]:
        # OpenAI embeds queries and passages the same way, so `kind` is unused.
        vectors: list[list[float]] = []
        for start in range(0, len(texts), self._batch_size):
            body: dict[str, object] = {
                "model": self._model,
                "input": list(texts[start : start + self._batch_size]),
            }
            if self._dimensions:
                body["dimensions"] = self._dimensions
            data = _post(self._client, "/embeddings", json=body)
            rows = data.get("data")
            if not isinstance(rows, list):
                raise ProviderError("OpenAI embeddings response had no data", retryable=False)
            ordered = sorted(rows, key=lambda row: int(row["index"]))
            vectors.extend([float(x) for x in row["embedding"]] for row in ordered)
        if len(vectors) != len(texts):
            raise ProviderError(
                f"OpenAI returned {len(vectors)} embeddings for {len(texts)} texts",
                retryable=False,
            )
        return vectors
