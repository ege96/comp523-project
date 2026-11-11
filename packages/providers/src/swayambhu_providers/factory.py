"""Builds the configured providers. Swapping a provider is a settings change, not a code change."""

import httpx2 as httpx

from swayambhu_providers import Embedder, Transcriber, Translator
from swayambhu_providers.elevenlabs_provider import ElevenLabsTranscriber, elevenlabs_client
from swayambhu_providers.fake_provider import FakeEmbedder, FakeTranscriber, FakeTranslator
from swayambhu_providers.google_provider import GoogleNmtTranslator
from swayambhu_providers.identity import local_embedding_name
from swayambhu_providers.openai_provider import (
    OpenAIEmbedder,
    OpenAITranscriber,
    openai_client,
)
from swayambhu_providers.settings import ProviderSettings


class ProviderConfigError(ValueError):
    """A provider is selected but a setting it needs is missing."""


def _required(value: object, env_name: str, provider: str) -> str:
    if value is None:
        raise ProviderConfigError(f"{env_name} must be set to use the {provider} provider")
    secret = getattr(value, "get_secret_value", None)
    return str(secret() if secret else value)


def build_transcriber(settings: ProviderSettings) -> Transcriber:
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


def build_translator(settings: ProviderSettings) -> Translator:
    if settings.translation_provider == "fake":
        return FakeTranslator()
    key = _required(settings.google_translate_api_key, "GOOGLE_TRANSLATE_API_KEY", "google_nmt")
    return GoogleNmtTranslator(httpx.Client(timeout=settings.provider_timeout_seconds), key)


def build_embedder(settings: ProviderSettings) -> Embedder:
    provider = settings.embedding_provider
    if provider == "fake":
        return FakeEmbedder(settings.embedding_dimensions or 8)
    model = _required(settings.embedding_model, "EMBEDDING_MODEL", provider)
    if provider == "local":
        return _build_local_embedder(settings, model)
    key = _required(settings.openai_api_key, "OPENAI_API_KEY", "openai")
    client = openai_client(key, timeout=settings.provider_timeout_seconds)
    return OpenAIEmbedder(client, model, settings.embedding_dimensions)


def embedder_name(settings: ProviderSettings) -> str:
    """The `name` the configured embedder will have, without loading a model or needing a key.
    Must match each Embedder's own `name` (tests check that)."""
    provider = settings.embedding_provider
    if provider == "fake":
        return f"fake:hash@{settings.embedding_dimensions or 8}"
    model = _required(settings.embedding_model, "EMBEDDING_MODEL", provider)
    if provider == "local":
        return local_embedding_name(
            model,
            settings.embedding_model_revision,
            query_prefix=settings.embedding_query_prefix,
            passage_prefix=settings.embedding_passage_prefix,
            max_tokens=settings.local_embedding_max_tokens,
        )
    dimensions = settings.embedding_dimensions
    return f"openai:{model}" + (f"@{dimensions}" if dimensions else "")


def _build_local_embedder(settings: ProviderSettings, model: str) -> Embedder:
    # Imported here so the other providers don't load ONNX Runtime.
    from swayambhu_providers.local_provider import LocalOnnxEmbedder, find_model_file

    if settings.embedding_dimensions is not None:
        raise ProviderConfigError(
            "EMBEDDING_DIMENSIONS must be empty for the local provider: the model fixes it"
        )
    model_dir = settings.local_model_dir / model
    if find_model_file(model_dir) is None or not (model_dir / "tokenizer.json").is_file():
        raise ProviderConfigError(
            f"local embedding model not found: {model_dir} needs model.onnx and tokenizer.json"
        )
    return LocalOnnxEmbedder(
        model,
        model_dir,
        revision=settings.embedding_model_revision,
        query_prefix=settings.embedding_query_prefix,
        passage_prefix=settings.embedding_passage_prefix,
        max_tokens=settings.local_embedding_max_tokens,
        threads=settings.local_embedding_threads,
        batch_size=settings.local_embedding_batch_size,
    )
