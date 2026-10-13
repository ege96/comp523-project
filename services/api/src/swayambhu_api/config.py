from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict

# Google's published signing keys for Firebase Auth ID tokens, in JWK form.
FIREBASE_JWKS_URL = (
    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"
)


class Settings(BaseSettings):
    """API settings, read from environment variables (Proposal: names not yet agreed)."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_env: str = "development"
    # libpq connection string, e.g. postgresql://user:pass@host:5432/swayambhu
    database_url: str = "postgresql://swayambhu@localhost:5432/swayambhu"
    db_connect_timeout_seconds: int = 3
    # Firebase project whose ID tokens we accept. Public (it is also in the web config).
    # Unset means sign-in is not configured: every authenticated request gets a 503.
    firebase_project_id: str | None = None
    firebase_jwks_url: str = FIREBASE_JWKS_URL


@lru_cache
def get_settings() -> Settings:
    return Settings()
