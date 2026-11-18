"""Microsoft MAI-Transcribe speech-to-text, through Azure Speech's fast transcription API.

MAI models run in "enhanced mode" of the synchronous `transcriptions:transcribe` call. The
endpoint is the Speech resource's own (https://<resource>.cognitiveservices.azure.com or
https://<region>.api.cognitive.microsoft.com) and must be in a region that serves the model.
Verify the API version, model id, regions and language list against Microsoft's docs before
production use: MAI-Transcribe-2 lists Nepali but not Nepal Bhasa (checked 2026-11-18).
"""

import json
from collections.abc import Sequence

import httpx2 as httpx

from swayambhu_providers import (
    AudioClip,
    ProviderError,
    TranscribedSegment,
    raise_for_status,
)

AZURE_SPEECH_API_VERSION = "2025-10-15"


def azure_speech_client(api_key: str, endpoint: str, timeout: float = 120) -> httpx.Client:
    return httpx.Client(
        base_url=endpoint.rstrip("/"),
        headers={"Ocp-Apim-Subscription-Key": api_key},
        timeout=timeout,
    )


class MaiTranscriber:
    """Transcribes one clip into one segment, timed by the phrases Azure returns."""

    def __init__(self, client: httpx.Client, model: str) -> None:
        self._client = client
        self._model = model

    @property
    def name(self) -> str:
        return f"azure:{self._model}"

    def transcribe(
        self, clip: AudioClip, language_hints: Sequence[str]
    ) -> list[TranscribedSegment]:
        definition: dict[str, object] = {"enhancedMode": {"enabled": True, "model": self._model}}
        # `locales` takes one code and forces it. With none the model detects the language,
        # which is as accurate on Nepali (FLEURS test, 2026-11-18). Nepal Bhasa ("new") has no
        # code, so it is sent without one rather than pushed towards Nepali.
        if len(language_hints) == 1 and len(language_hints[0]) == 2:
            definition["locales"] = [language_hints[0]]
        try:
            with clip.path.open("rb") as audio:
                response = self._client.post(
                    f"/speechtotext/transcriptions:transcribe?api-version={AZURE_SPEECH_API_VERSION}",
                    files={
                        "audio": (clip.path.name, audio),
                        "definition": (None, json.dumps(definition), "application/json"),
                    },
                )
        except httpx.TimeoutException as exc:
            raise ProviderError(f"Azure Speech timed out: {exc}", retryable=True) from exc
        except httpx.TransportError as exc:
            raise ProviderError(f"Azure Speech unreachable: {exc}", retryable=True) from exc
        raise_for_status(response.status_code, response.text, "Azure Speech")
        try:
            data = response.json()
        except ValueError as exc:
            raise ProviderError(
                "Azure Speech returned a response that is not JSON", retryable=False
            ) from exc
        if not isinstance(data, dict):
            raise ProviderError(
                "Azure Speech returned an unexpected response shape", retryable=False
            )

        phrases = [p for p in data.get("phrases") or [] if isinstance(p, dict)]
        combined = [p for p in data.get("combinedPhrases") or [] if isinstance(p, dict)]
        text = " ".join(str(p.get("text", "")).strip() for p in combined or phrases).strip()
        if not text:
            return []
        start_ms, end_ms = 0, clip.duration_ms
        timed = [p for p in phrases if "offsetMilliseconds" in p and "durationMilliseconds" in p]
        if timed:
            first = min(int(p["offsetMilliseconds"]) for p in timed)
            last = max(int(p["offsetMilliseconds"]) + int(p["durationMilliseconds"]) for p in timed)
            start_ms, end_ms = max(0, first), min(clip.duration_ms, last)
            if end_ms <= start_ms:
                start_ms, end_ms = 0, clip.duration_ms
        return [
            TranscribedSegment(
                start_ms=start_ms, end_ms=end_ms, text=text, language=_detected(phrases)
            )
        ]


def _detected(phrases: list[dict[str, object]]) -> str | None:
    """The clip's language if every phrase names the same one ("ne-NP" -> "ne"). Mixed or
    missing means the translator's detection decides."""
    codes = {str(p["locale"]).split("-")[0].lower() for p in phrases if p.get("locale")}
    return codes.pop() if len(codes) == 1 else None
