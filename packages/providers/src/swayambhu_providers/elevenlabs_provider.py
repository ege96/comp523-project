"""ElevenLabs Scribe speech-to-text over the REST API.

Verify the endpoint, model id and language coverage against ElevenLabs' docs before
production use.
"""

from collections.abc import Sequence

import httpx2 as httpx

from swayambhu_providers import (
    AudioClip,
    ProviderError,
    TranscribedSegment,
    raise_for_status,
)

ELEVENLABS_BASE_URL = "https://api.elevenlabs.io/v1"


def elevenlabs_client(
    api_key: str, base_url: str = ELEVENLABS_BASE_URL, timeout: float = 120
) -> httpx.Client:
    return httpx.Client(base_url=base_url, headers={"xi-api-key": api_key}, timeout=timeout)


class ElevenLabsTranscriber:
    """Transcribes one clip into one segment, timed by the words ElevenLabs returns."""

    def __init__(self, client: httpx.Client, model: str) -> None:
        self._client = client
        self._model = model

    @property
    def name(self) -> str:
        return f"elevenlabs:{self._model}"

    def transcribe(
        self, clip: AudioClip, language_hints: Sequence[str]
    ) -> list[TranscribedSegment]:
        form = {"model_id": self._model}
        if len(language_hints) == 1:
            form["language_code"] = language_hints[0]
        try:
            with clip.path.open("rb") as audio:
                response = self._client.post(
                    "/speech-to-text", data=form, files={"file": (clip.path.name, audio)}
                )
        except httpx.TimeoutException as exc:
            raise ProviderError(f"ElevenLabs timed out: {exc}", retryable=True) from exc
        except httpx.TransportError as exc:
            raise ProviderError(f"ElevenLabs unreachable: {exc}", retryable=True) from exc
        raise_for_status(response.status_code, response.text, "ElevenLabs")
        data = response.json()
        text = str(data.get("text", "")).strip()
        if not text:
            return []
        words = [w for w in data.get("words") or [] if w.get("type", "word") == "word"]
        start_ms, end_ms = 0, clip.duration_ms
        if words:
            start_ms = max(0, round(float(words[0]["start"]) * 1000))
            end_ms = min(clip.duration_ms, round(float(words[-1]["end"]) * 1000))
            if end_ms <= start_ms:
                start_ms, end_ms = 0, clip.duration_ms
        language = data.get("language_code")
        return [
            TranscribedSegment(
                start_ms=start_ms,
                end_ms=end_ms,
                text=text,
                language=language if isinstance(language, str) else None,
            )
        ]
