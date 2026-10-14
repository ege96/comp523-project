"""Deterministic offline providers for tests and local development without API keys.

Their output is obviously synthetic. Never configure them in production.
"""

import hashlib
import math
from collections.abc import Sequence

from swayambhu_providers import AudioClip, EmbeddingKind, TranscribedSegment


class FakeTranscriber:
    name = "fake:transcriber"

    def transcribe(
        self, clip: AudioClip, language_hints: Sequence[str]
    ) -> list[TranscribedSegment]:
        language = language_hints[0] if language_hints else None
        return [
            TranscribedSegment(
                0, clip.duration_ms, f"[fake transcript of {clip.path.name}]", language
            )
        ]


class FakeTranslator:
    name = "fake:translator"

    def translate_to_english(self, texts: Sequence[str], source_language: str) -> list[str]:
        return [f"[fake {source_language}->en] {text}" for text in texts]


class FakeEmbedder:
    """Unit vectors derived from a hash of the text: same text, same vector."""

    def __init__(self, dimensions: int = 8) -> None:
        self._dimensions = dimensions

    @property
    def name(self) -> str:
        return f"fake:hash@{self._dimensions}"

    def embed(self, texts: Sequence[str], kind: EmbeddingKind) -> list[list[float]]:
        vectors = []
        for text in texts:
            digest = hashlib.sha256(text.encode()).digest()
            raw = [digest[i % len(digest)] - 127.5 for i in range(self._dimensions)]
            norm = math.sqrt(sum(x * x for x in raw)) or 1.0
            vectors.append([x / norm for x in raw])
        return vectors
