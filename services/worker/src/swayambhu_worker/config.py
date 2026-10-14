from typing import Literal

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class WorkerSettings(BaseSettings):
    """Worker settings, read from environment variables (Proposal: names not yet agreed)."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql://swayambhu@localhost:5432/swayambhu"
    poll_interval_seconds: float = 5.0

    # AI providers (D-011..D-013). Model names have no defaults: they are vendor- and
    # time-sensitive, so they must be set explicitly. `fake` runs offline for local dev.
    transcription_provider: Literal["openai", "elevenlabs", "fake"] = "openai"
    transcription_model: str | None = None
    translation_provider: Literal["google_nmt", "fake"] = "google_nmt"
    # Must match the API's settings, which embed search queries with the same model.
    embedding_provider: Literal["openai", "fake"] = "openai"
    embedding_model: str | None = None
    embedding_dimensions: int | None = None
    provider_timeout_seconds: float = 120.0

    openai_api_key: SecretStr | None = None
    elevenlabs_api_key: SecretStr | None = None
    google_translate_api_key: SecretStr | None = None
