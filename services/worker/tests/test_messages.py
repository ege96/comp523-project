import pytest
from swayambhu_providers import ProviderError

from swayambhu_worker.audio import AudioError
from swayambhu_worker.messages import explain


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (ProviderError('{"error": {"code": 403}}', retryable=False, status_code=403), "refused"),
        (ProviderError("slow down", retryable=True, status_code=429), "limiting requests"),
        (ProviderError("busy", retryable=True, status_code=503), "didn't respond"),
        (ProviderError("timed out", retryable=True), "didn't respond"),
        (ProviderError("bad pair", retryable=False, status_code=400), "couldn't process"),
    ],
)
def test_provider_failures_are_explained_without_the_raw_response(
    error: ProviderError, expected: str
) -> None:
    message = explain("translate", error)
    assert message.startswith("The translation service")
    assert expected in message
    assert str(error) not in message
    assert "Retry" in message


def test_a_translation_the_service_refuses_points_to_the_language() -> None:
    error = ProviderError("bad pair", retryable=False, status_code=400)
    assert "Edit details" in explain("translate", error)
    assert "Edit details" not in explain("transcribe", error)


def test_other_failures() -> None:
    assert "converting it to MP3" in explain("transcribe", AudioError("ffprobe failed"))
    assert "missing from storage" in explain("playback", FileNotFoundError("x"))
    assert "worker's logs" in explain("index", RuntimeError("boom"))
    assert explain("playback", ProviderError("x", retryable=False)).startswith("An outside service")
