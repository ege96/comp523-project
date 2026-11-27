"""OpenAI transcription and embeddings over the REST API.

Verify model names, request limits and supported languages against OpenAI's docs before
production use; they change often.
"""

from collections.abc import Sequence

import httpx2 as httpx

from swayambhu_providers import (
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
    try:
        data = response.json()
    except ValueError as exc:
        raise ProviderError("OpenAI returned a response that is not JSON", retryable=False) from exc
    if not isinstance(data, dict):
        raise ProviderError("OpenAI returned an unexpected response shape", retryable=False)
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

    `languages` is the expected-languages list sent when no language was confirmed (e.g.
    ["ne", "en"]). A confirmed language goes first, with the rest kept for mixed speech.
    The `languages` field is for gpt-transcribe; older models took a single `language`.
    """

    def __init__(self, client: httpx.Client, model: str, languages: Sequence[str] = ()) -> None:
        self._client = client
        self._model = model
        self._languages = list(languages)

    @property
    def name(self) -> str:
        return f"openai:{self._model}"

    def _expected_languages(self, language_hints: Sequence[str]) -> list[str]:
        # The API rejects codes it doesn't support, and Nepal Bhasa ("new") has none. Sending
        # the default list for it would push the model towards Nepali, so send nothing.
        if any(len(code) != 2 for code in language_hints):
            return []
        expected = list(dict.fromkeys(language_hints))
        return expected + [code for code in self._languages if code not in expected]

    def transcribe(
        self, clip: AudioClip, language_hints: Sequence[str]
    ) -> list[TranscribedSegment]:
        form: dict[str, str | list[str]] = {"model": self._model, "response_format": "json"}
        languages = self._expected_languages(language_hints)
        if languages:
            form["languages[]"] = languages
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
        return [
            TranscribedSegment(
                start_ms=0, end_ms=clip.duration_ms, text=text, language=_detected(data)
            )
        ]


def _detected(data: dict[str, object]) -> str | None:
    """The clip's language if the model names exactly one. An empty list means it couldn't
    tell; several mean mixed speech. Either way the translator's detection decides."""
    found = data.get("languages")
    if not isinstance(found, list) or len(found) != 1 or not isinstance(found[0], dict):
        return None
    code = found[0].get("code")
    return code if isinstance(code, str) and code else None


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
            vectors.extend(self._parse_batch(data, len(body["input"])))  # type: ignore[arg-type]
        return vectors

    def _parse_batch(self, data: dict[str, object], count: int) -> list[list[float]]:
        """The vectors of one response in input order, checked against the request."""
        rows = data.get("data")
        if not isinstance(rows, list):
            raise ProviderError("OpenAI embeddings response had no data", retryable=False)
        by_index: dict[int, list[float]] = {}
        try:
            for row in rows:
                index = row["index"]
                if isinstance(index, bool) or not isinstance(index, int) or index in by_index:
                    raise ValueError(f"bad or duplicate index {index!r}")
                by_index[index] = [float(x) for x in row["embedding"]]
        except (KeyError, TypeError, ValueError) as exc:
            raise ProviderError(
                f"OpenAI returned a malformed embeddings response: {exc}", retryable=False
            ) from exc
        if sorted(by_index) != list(range(count)):
            raise ProviderError(
                f"OpenAI returned embedding indices {sorted(by_index)} for {count} texts",
                retryable=False,
            )
        vectors = [by_index[i] for i in range(count)]
        expected = self._dimensions or (len(vectors[0]) if vectors else 0)
        if any(not v or len(v) != expected for v in vectors):
            raise ProviderError(
                f"OpenAI returned embeddings that are not {expected}-dimensional",
                retryable=False,
            )
        return vectors
