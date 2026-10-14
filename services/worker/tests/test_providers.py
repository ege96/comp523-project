import json
from pathlib import Path

import httpx2 as httpx
import pytest
from pydantic import SecretStr

from swayambhu_worker.config import WorkerSettings
from swayambhu_worker.providers import AudioClip, ProviderError
from swayambhu_worker.providers.elevenlabs_provider import ElevenLabsTranscriber
from swayambhu_worker.providers.factory import (
    ProviderConfigError,
    build_embedder,
    build_transcriber,
    build_translator,
)
from swayambhu_worker.providers.fake_provider import FakeEmbedder, FakeTranscriber
from swayambhu_worker.providers.google_provider import GoogleNmtTranslator
from swayambhu_worker.providers.openai_provider import OpenAIEmbedder, OpenAITranscriber


def client(handler: object, base_url: str = "https://example.test") -> httpx.Client:
    return httpx.Client(base_url=base_url, transport=httpx.MockTransport(handler))  # type: ignore[arg-type]


@pytest.fixture
def clip(tmp_path: Path) -> AudioClip:
    path = tmp_path / "clip-0001.flac"
    path.write_bytes(b"not really audio")
    return AudioClip(path=path, duration_ms=12_000)


def test_openai_transcriber_spans_the_clip(clip: AudioClip) -> None:
    seen: dict[str, bytes] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/audio/transcriptions"
        seen["body"] = request.read()
        return httpx.Response(200, json={"text": " नमस्ते ", "language": "ne"})

    transcriber = OpenAITranscriber(client(handler), "some-transcribe-model")
    segments = transcriber.transcribe(clip, ["ne"])
    assert [(s.start_ms, s.end_ms, s.text, s.language) for s in segments] == [
        (0, 12_000, "नमस्ते", "ne")
    ]
    assert b'name="language"' in seen["body"]
    assert transcriber.name == "openai:some-transcribe-model"


def test_openai_transcriber_omits_language_without_a_two_letter_code(clip: AudioClip) -> None:
    """Nepal Bhasa ("new") has no ISO 639-1 code, so the model has to detect it."""
    bodies: list[bytes] = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(request.read())
        return httpx.Response(200, json={"text": ""})

    assert OpenAITranscriber(client(handler), "m").transcribe(clip, ["new"]) == []
    assert b'name="language"' not in bodies[0]


@pytest.mark.parametrize(("status", "retryable"), [(429, True), (503, True), (400, False)])
def test_http_errors_say_whether_to_retry(clip: AudioClip, status: int, retryable: bool) -> None:
    transcriber = OpenAITranscriber(client(lambda _: httpx.Response(status, text="nope")), "m")
    with pytest.raises(ProviderError) as info:
        transcriber.transcribe(clip, [])
    assert info.value.retryable is retryable


def test_timeouts_are_retryable(clip: AudioClip) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=request)

    with pytest.raises(ProviderError) as info:
        OpenAITranscriber(client(handler), "m").transcribe(clip, [])
    assert info.value.retryable


def test_openai_embedder_batches_and_keeps_order() -> None:
    requests: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.read())
        requests.append(body)
        rows = [{"index": i, "embedding": [float(len(t))]} for i, t in enumerate(body["input"])]
        return httpx.Response(200, json={"data": list(reversed(rows))})

    embedder = OpenAIEmbedder(client(handler), "embed-model", dimensions=256, batch_size=2)
    assert embedder.embed(["a", "bb", "ccc"], "passage") == [[1.0], [2.0], [3.0]]
    assert [r["input"] for r in requests] == [["a", "bb"], ["ccc"]]
    assert all(r["dimensions"] == 256 for r in requests)
    assert embedder.name == "openai:embed-model@256"
    assert OpenAIEmbedder(client(handler), "embed-model", None).name == "openai:embed-model"


def test_elevenlabs_uses_word_timings(clip: AudioClip) -> None:
    words = [
        {"text": "म", "start": 0.4, "end": 0.6, "type": "word"},
        {"text": " ", "start": 0.6, "end": 0.7, "type": "spacing"},
        {"text": "आएँ", "start": 0.7, "end": 1.25, "type": "word"},
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["xi-api-key"] == "k"
        return httpx.Response(200, json={"text": "म आएँ", "language_code": "nep", "words": words})

    transcriber = ElevenLabsTranscriber(
        httpx.Client(
            base_url="https://example.test",
            headers={"xi-api-key": "k"},
            transport=httpx.MockTransport(handler),
        ),
        "scribe-model",
    )
    [segment] = transcriber.transcribe(clip, ["ne"])
    assert (segment.start_ms, segment.end_ms, segment.language) == (400, 1250, "nep")


def test_google_translator_sends_key_in_header_and_keeps_order() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert "key=" not in str(request.url)
        assert request.headers["X-Goog-Api-Key"] == "secret"
        body = json.loads(request.read())
        assert body["source"] == "new"
        assert body["target"] == "en"
        translations = [{"translatedText": t.upper()} for t in body["q"]]
        return httpx.Response(200, json={"data": {"translations": translations}})

    translator = GoogleNmtTranslator(client(handler), "secret", url="https://example.test/t")
    assert translator.translate_to_english(["a", "b"], "new") == ["A", "B"]


def test_google_translator_rejects_a_short_response() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": {"translations": []}})

    translator = GoogleNmtTranslator(client(handler), "k", url="https://example.test/t")
    with pytest.raises(ProviderError):
        translator.translate_to_english(["a"], "ne")


def test_fake_embedder_is_deterministic_and_unit_length() -> None:
    embedder = FakeEmbedder(dimensions=16)
    first, again, other = embedder.embed(["x", "x", "y"], "query")
    assert first == again != other
    assert abs(sum(v * v for v in first) - 1.0) < 1e-9
    # Pinned, and the same in services/api/tests/test_embeddings.py: search only finds
    # chunks embedded by a matching model, so the two fakes must agree.
    [pinned] = FakeEmbedder(dimensions=4).embed(["x"], "passage")
    assert [round(v, 6) for v in pinned] == [-0.557115, -0.097917, -0.712431, -0.415304]


def test_factory_picks_providers_from_settings() -> None:
    settings = WorkerSettings(
        transcription_provider="elevenlabs",
        transcription_model="scribe-model",
        elevenlabs_api_key=SecretStr("k"),
        embedding_provider="openai",
        embedding_model="embed-model",
        embedding_dimensions=1024,
        openai_api_key=SecretStr("k"),
        google_translate_api_key=SecretStr("k"),
    )
    assert build_transcriber(settings).name == "elevenlabs:scribe-model"
    assert build_embedder(settings).name == "openai:embed-model@1024"
    assert build_translator(settings).name == "google:nmt"

    fake = WorkerSettings(
        transcription_provider="fake", translation_provider="fake", embedding_provider="fake"
    )
    assert isinstance(build_transcriber(fake), FakeTranscriber)
    assert build_translator(fake).name == "fake:translator"
    assert build_embedder(fake).name == "fake:hash@8"


@pytest.mark.parametrize(
    ("settings", "missing"),
    [
        (WorkerSettings(transcription_model=None), "TRANSCRIPTION_MODEL"),
        (WorkerSettings(transcription_model="m", openai_api_key=None), "OPENAI_API_KEY"),
    ],
)
def test_factory_names_the_missing_setting(settings: WorkerSettings, missing: str) -> None:
    with pytest.raises(ProviderConfigError, match=missing):
        build_transcriber(settings)


def test_factory_requires_translation_key() -> None:
    with pytest.raises(ProviderConfigError, match="GOOGLE_TRANSLATE_API_KEY"):
        build_translator(WorkerSettings(google_translate_api_key=None))
