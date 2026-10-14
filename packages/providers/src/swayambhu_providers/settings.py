from typing import Literal

from pydantic import SecretStr
from pydantic_settings import BaseSettings


class ProviderSettings(BaseSettings):
    """AI provider settings shared by the API and the worker (D-011..D-013).

    Each service's settings class inherits these, so both read the same environment
    variables. That matters for embeddings: the API embeds search queries with the model the
    worker used for stored chunks. Model names have no defaults because they are vendor- and
    time-sensitive. `fake` runs offline for local dev and tests.
    """

    transcription_provider: Literal["openai", "elevenlabs", "fake"] = "openai"
    transcription_model: str | None = None
    translation_provider: Literal["google_nmt", "fake"] = "google_nmt"
    embedding_provider: Literal["openai", "fake"] = "openai"
    embedding_model: str | None = None
    embedding_dimensions: int | None = None
    provider_timeout_seconds: float = 120.0

    openai_api_key: SecretStr | None = None
    elevenlabs_api_key: SecretStr | None = None
    google_translate_api_key: SecretStr | None = None
