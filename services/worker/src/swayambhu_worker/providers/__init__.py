"""Swappable AI providers: transcription, translation and embeddings.

The pipeline only sees these interfaces. Which implementation runs is a config choice
(`factory.py`), so a provider can change without touching pipeline code (D-011..D-013).
Model names, keys and dimensions always come from config, never from code.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Protocol

# What a text is embedded as. Some models (e.g. multilingual E5) need a different prefix
# for search queries and stored passages; others ignore it.
EmbeddingKind = Literal["query", "passage"]


class ProviderError(Exception):
    """A provider call failed. `retryable` is True for rate limits, timeouts and 5xx."""

    def __init__(self, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.retryable = retryable


@dataclass(frozen=True)
class AudioClip:
    """A short piece of a recording, cut by the worker at pauses (roughly 5-20 s)."""

    path: Path
    duration_ms: int


@dataclass(frozen=True)
class TranscribedSegment:
    """Timestamps are relative to the start of the clip that was transcribed."""

    start_ms: int
    end_ms: int
    text: str
    language: str | None  # ISO 639 code if the provider reported one


class Transcriber(Protocol):
    @property
    def name(self) -> str:
        """Provenance stored in interviews.transcribed_by, e.g. "openai:gpt-transcribe"."""
        ...

    def transcribe(
        self, clip: AudioClip, language_hints: Sequence[str]
    ) -> list[TranscribedSegment]: ...


class Translator(Protocol):
    @property
    def name(self) -> str:
        """Provenance stored in interviews.translated_by, e.g. "google:nmt"."""
        ...

    def translate_to_english(self, texts: Sequence[str], source_language: str) -> list[str]:
        """One English string per input, in order."""
        ...


class Embedder(Protocol):
    @property
    def name(self) -> str:
        """Stored in chunk_embeddings.model. Includes the dimension when it was configured,
        because the same model at another dimension gives incomparable vectors."""
        ...

    def embed(self, texts: Sequence[str], kind: EmbeddingKind) -> list[list[float]]: ...


def raise_for_status(status_code: int, body: str, provider: str) -> None:
    """Turn an HTTP error into a ProviderError, flagging what is worth retrying."""
    if status_code < 400:
        return
    retryable = status_code == 429 or status_code >= 500
    # Bodies can echo the request; keep the message short.
    raise ProviderError(f"{provider} returned {status_code}: {body[:300]}", retryable=retryable)
