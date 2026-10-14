from functools import lru_cache
from typing import Literal

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

# Google's published signing keys for Firebase Auth ID tokens, in JWK form.
FIREBASE_JWKS_URL = (
    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"
)


class Settings(BaseSettings):
    """API settings, read from environment variables (Proposal: names not yet agreed)."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_env: str = "development"
    # json: one JSON object per line, for OpenShift's log collection. text: easier to read locally.
    log_format: Literal["json", "text"] = "json"
    log_level: str = "INFO"
    # libpq connection string, e.g. postgresql://user:pass@host:5432/swayambhu
    database_url: str = "postgresql://swayambhu@localhost:5432/swayambhu"
    db_connect_timeout_seconds: int = 3
    # Firebase project whose ID tokens we accept. Public (it is also in the web config).
    # Unset means sign-in is not configured: every authenticated request gets a 503.
    firebase_project_id: str | None = None
    firebase_jwks_url: str = FIREBASE_JWKS_URL
    # Search queries are embedded with the same model the worker used for stored chunks
    # (D-012), so these must match the worker's settings. No model default: it is
    # vendor- and time-sensitive. `fake` runs offline for local dev and tests.
    embedding_provider: Literal["openai", "fake"] = "openai"
    embedding_model: str | None = None
    embedding_dimensions: int | None = None
    embedding_timeout_seconds: float = 10.0
    openai_api_key: SecretStr | None = None


@lru_cache
def get_settings() -> Settings:
    return Settings()
