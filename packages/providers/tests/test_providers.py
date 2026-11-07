import json
from pathlib import Path

import httpx2 as httpx
import pytest
from pydantic import SecretStr

from swayambhu_providers import AudioClip, ProviderError, Translation
from swayambhu_providers.elevenlabs_provider import ElevenLabsTranscriber
from swayambhu_providers.factory import (
    ProviderConfigError,
    build_embedder,
    build_transcriber,
    build_translator,
    embedder_name,
)
from swayambhu_providers.fake_provider import FakeEmbedder, FakeTranscriber
from swayambhu_providers.google_provider import GoogleNmtTranslator
from swayambhu_providers.openai_provider import OpenAIEmbedder, OpenAITranscriber
from swayambhu_providers.settings import ProviderSettings


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
    assert (info.value.retryable, info.value.status_code) == (retryable, status)


def test_timeouts_are_retryable(clip: AudioClip) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=request)

    with pytest.raises(ProviderError) as info:
        OpenAITranscriber(client(handler), "m").transcribe(clip, [])
    assert info.value.retryable
    assert info.value.status_code is None


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
    assert translator.translate_to_english(["a", "b"], "new") == [
        Translation("A"),
        Translation("B"),
    ]


def test_google_translator_lets_google_detect_an_unknown_language() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert "source" not in json.loads(request.read())
        translations = [{"translatedText": "hi", "detectedSourceLanguage": "ne"}]
        return httpx.Response(200, json={"data": {"translations": translations}})

    translator = GoogleNmtTranslator(client(handler), "k", url="https://example.test/t")
    assert translator.translate_to_english(["नमस्ते"], None) == [Translation("hi", "ne")]


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
    settings = ProviderSettings(
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
    assert build_embedder(settings).name == embedder_name(settings) == "openai:embed-model@1024"
    unsized = settings.model_copy(update={"embedding_dimensions": None})
    assert build_embedder(unsized).name == embedder_name(unsized) == "openai:embed-model"
    assert build_translator(settings).name == "google:nmt"

    fake = ProviderSettings(
        transcription_provider="fake", translation_provider="fake", embedding_provider="fake"
    )
    assert isinstance(build_transcriber(fake), FakeTranscriber)
    assert build_translator(fake).name == "fake:translator"
    assert build_embedder(fake).name == embedder_name(fake) == "fake:hash@8"


@pytest.mark.parametrize(
    ("settings", "missing"),
    [
        (ProviderSettings(transcription_model=None), "TRANSCRIPTION_MODEL"),
        (ProviderSettings(transcription_model="m", openai_api_key=None), "OPENAI_API_KEY"),
    ],
)
def test_factory_names_the_missing_setting(settings: ProviderSettings, missing: str) -> None:
    with pytest.raises(ProviderConfigError, match=missing):
        build_transcriber(settings)


def test_factory_requires_translation_key() -> None:
    with pytest.raises(ProviderConfigError, match="GOOGLE_TRANSLATE_API_KEY"):
        build_translator(ProviderSettings(google_translate_api_key=None))


def test_empty_env_values_count_as_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    """`.env.example` lists every key with an empty value; that must not break parsing."""
    monkeypatch.setenv("EMBEDDING_DIMENSIONS", "")
    monkeypatch.setenv("OPENAI_API_KEY", "")
    settings = ProviderSettings()
    assert settings.embedding_dimensions is None
    assert settings.openai_api_key is None


def _tiny_local_model(model_dir: Path) -> None:
    """A word-level tokenizer and an ONNX "encoder" whose token states are a lookup table,
    so pooled vectors can be checked by hand."""
    import onnx
    from onnx import TensorProto, helper
    from tokenizers import Tokenizer
    from tokenizers.models import WordLevel
    from tokenizers.pre_tokenizers import WhitespaceSplit

    vocab = {"[UNK]": 0, "query:": 1, "passage:": 2, "a": 3, "b": 4}
    tokenizer = Tokenizer(WordLevel(vocab, unk_token="[UNK]"))  # noqa: S106
    tokenizer.pre_tokenizer = WhitespaceSplit()  # type: ignore[assignment]
    model_dir.mkdir(parents=True)
    tokenizer.save(str(model_dir / "tokenizer.json"))

    # Token states: query: -> x, passage: -> y, a -> x, b -> z.
    table = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 0, 0], [0, 0, 1]]
    graph = helper.make_graph(
        [helper.make_node("Gather", ["table", "input_ids"], ["last_hidden_state"])],
        "tiny",
        [
            helper.make_tensor_value_info("input_ids", TensorProto.INT64, ["b", "s"]),
            helper.make_tensor_value_info("attention_mask", TensorProto.INT64, ["b", "s"]),
        ],
        [helper.make_tensor_value_info("last_hidden_state", TensorProto.FLOAT, ["b", "s", 3])],
        [helper.make_tensor("table", TensorProto.FLOAT, [5, 3], [x for row in table for x in row])],
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)])
    model.ir_version = 9
    (model_dir / "onnx").mkdir()
    onnx.save(model, str(model_dir / "onnx" / "model.onnx"))


def test_local_embedder_mean_pools_with_prefixes(tmp_path: Path) -> None:
    _tiny_local_model(tmp_path / "org" / "tiny")
    settings = ProviderSettings(
        embedding_provider="local",
        embedding_model="org/tiny",
        local_model_dir=tmp_path,
        embedding_query_prefix="query: ",
        embedding_passage_prefix="passage: ",
        local_embedding_batch_size=1,
    )
    embedder = build_embedder(settings)
    assert embedder.name == embedder_name(settings) == "local:org/tiny"

    # "query: a" -> mean(x, x) = x. "query: a b b" -> mean(x, x, z, z) -> (1, 0, 1)/sqrt2.
    # Batch size 1 and different lengths also check that padding never enters the mean.
    short, long = embedder.embed(["a", "a b b"], "query")
    assert short == pytest.approx([1, 0, 0])
    assert long == pytest.approx([2**-0.5, 0, 2**-0.5])
    [passage] = embedder.embed(["a"], "passage")
    assert passage == pytest.approx([2**-0.5, 2**-0.5, 0])


def test_local_embedder_truncates_long_text(tmp_path: Path) -> None:
    _tiny_local_model(tmp_path / "tiny")
    settings = ProviderSettings(
        embedding_provider="local",
        embedding_model="tiny",
        local_model_dir=tmp_path,
        local_embedding_max_tokens=2,
    )
    [vector] = build_embedder(settings).embed(["a a b b b"], "passage")
    assert vector == pytest.approx([1, 0, 0])


def test_local_embedder_needs_model_files_and_no_dimension(tmp_path: Path) -> None:
    settings = ProviderSettings(
        embedding_provider="local", embedding_model="missing", local_model_dir=tmp_path
    )
    with pytest.raises(ProviderConfigError, match=r"model\.onnx"):
        build_embedder(settings)
    _tiny_local_model(tmp_path / "tiny")
    sized = settings.model_copy(update={"embedding_model": "tiny", "embedding_dimensions": 384})
    with pytest.raises(ProviderConfigError, match="EMBEDDING_DIMENSIONS"):
        build_embedder(sized)


def test_prepare_model_moves_weights_out_and_keeps_vectors(tmp_path: Path) -> None:
    import onnx
    from onnx import numpy_helper

    from swayambhu_providers.local_provider import LocalOnnxEmbedder
    from swayambhu_providers.prepare_model import DATA_FILE, externalize

    _tiny_local_model(tmp_path / "tiny")
    # Widen the lookup table past the 1 KiB threshold so it goes to the data file.
    path = tmp_path / "tiny" / "onnx" / "model.onnx"
    model = onnx.load(str(path))
    [table] = model.graph.initializer
    wide = numpy_helper.to_array(table).repeat(100, axis=1)
    table.CopyFrom(numpy_helper.from_array(wide, "table"))
    model.graph.output[0].type.tensor_type.shape.dim[2].dim_value = wide.shape[1]
    onnx.save(model, str(path))
    [before] = LocalOnnxEmbedder("tiny", tmp_path / "tiny").embed(["a b"], "passage")

    externalize(tmp_path / "tiny")

    assert (path.parent / DATA_FILE).stat().st_size >= wide.nbytes
    assert path.stat().st_size < wide.nbytes
    [after] = LocalOnnxEmbedder("tiny", tmp_path / "tiny").embed(["a b"], "passage")
    assert after == pytest.approx(before)
