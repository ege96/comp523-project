"""Builds the configured providers. Swapping a provider is a settings change, not a code change."""

import httpx2 as httpx

from swayambhu_worker.config import WorkerSettings
from swayambhu_worker.providers import Embedder, Transcriber, Translator
from swayambhu_worker.providers.elevenlabs_provider import ElevenLabsTranscriber, elevenlabs_client
from swayambhu_worker.providers.fake_provider import FakeEmbedder, FakeTranscriber, FakeTranslator
from swayambhu_worker.providers.google_provider import GoogleNmtTranslator
from swayambhu_worker.providers.openai_provider import (
    OpenAIEmbedder,
    OpenAITranscriber,
    openai_client,
)


class ProviderConfigError(ValueError):
    """A provider is selected but a setting it needs is missing."""


def _required(value: object, env_name: str, provider: str) -> str:
    if value is None:
        raise ProviderConfigError(f"{env_name} must be set to use the {provider} provider")
    secret = getattr(value, "get_secret_value", None)
    return str(secret() if secret else value)


def build_transcriber(settings: WorkerSettings) -> Transcriber:
    provider = settings.transcription_provider
    if provider == "fake":
        return FakeTranscriber()
    model = _required(settings.transcription_model, "TRANSCRIPTION_MODEL", provider)
    timeout = settings.provider_timeout_seconds
    if provider == "openai":
        key = _required(settings.openai_api_key, "OPENAI_API_KEY", provider)
        return OpenAITranscriber(openai_client(key, timeout=timeout), model)
    key = _required(settings.elevenlabs_api_key, "ELEVENLABS_API_KEY", provider)
    return ElevenLabsTranscriber(elevenlabs_client(key, timeout=timeout), model)


def build_translator(settings: WorkerSettings) -> Translator:
    if settings.translation_provider == "fake":
        return FakeTranslator()
    key = _required(settings.google_translate_api_key, "GOOGLE_TRANSLATE_API_KEY", "google_nmt")
    return GoogleNmtTranslator(httpx.Client(timeout=settings.provider_timeout_seconds), key)


def build_embedder(settings: WorkerSettings) -> Embedder:
    if settings.embedding_provider == "fake":
        return FakeEmbedder(settings.embedding_dimensions or 8)
    model = _required(settings.embedding_model, "EMBEDDING_MODEL", "openai")
    key = _required(settings.openai_api_key, "OPENAI_API_KEY", "openai")
    client = openai_client(key, timeout=settings.provider_timeout_seconds)
    return OpenAIEmbedder(client, model, settings.embedding_dimensions)
