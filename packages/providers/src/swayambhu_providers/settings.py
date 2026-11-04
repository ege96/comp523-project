from pathlib import Path
from typing import Literal

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class ProviderSettings(BaseSettings):
    """AI provider settings shared by the API and the worker (D-011..D-013).

    Each service's settings class inherits these, so both read the same environment
    variables. That matters for embeddings: the API embeds search queries with the model the
    worker used for stored chunks. Model names have no defaults because they are vendor- and
    time-sensitive. `fake` runs offline for local dev and tests.
    """

    # An empty value (`OPENAI_API_KEY=` in .env.example) means unset, not "".
    # Subclasses' model_config is merged with this.
    model_config = SettingsConfigDict(env_ignore_empty=True)

    transcription_provider: Literal["openai", "elevenlabs", "fake"] = "openai"
    transcription_model: str | None = None
    translation_provider: Literal["google_nmt", "fake"] = "google_nmt"
    embedding_provider: Literal["openai", "local", "fake"] = "openai"
    embedding_model: str | None = None
    embedding_dimensions: int | None = None
    # Prepended to every query or passage. multilingual-E5 needs "query: " and "passage: ".
    embedding_query_prefix: str = ""
    embedding_passage_prefix: str = ""
    # `local` provider: the model is read from LOCAL_MODEL_DIR/<EMBEDDING_MODEL>.
    local_model_dir: Path = Path("/opt/models")
    local_embedding_max_tokens: int = 512
    local_embedding_threads: int = 4
    # 4 keeps the worker's peak at ~540 MiB on CloudApps (16 hit ~860 MiB) at the same speed.
    local_embedding_batch_size: int = 4
    provider_timeout_seconds: float = 120.0

    openai_api_key: SecretStr | None = None
    elevenlabs_api_key: SecretStr | None = None
    google_translate_api_key: SecretStr | None = None
