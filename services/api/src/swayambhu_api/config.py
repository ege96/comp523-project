from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import SecretStr
from pydantic_settings import SettingsConfigDict
from swayambhu_providers.settings import ProviderSettings

# Google's published signing keys for Firebase Auth ID tokens, in JWK form.
FIREBASE_JWKS_URL = (
    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"
)


class Settings(ProviderSettings):
    """API settings, read from environment variables, then `.env` in the working directory
    (Proposal: names not yet agreed). AI provider settings come from ProviderSettings; the API
    uses only the embedding ones, to embed search queries."""

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
    # Where LocalMediaStore keeps recordings: the same directory the worker writes (D-007).
    media_root: Path = Path("/data/media")
    # Signs the expiring media links the player uses. Unset: a random key per process, which
    # only works with one API pod; set the same value on every pod before scaling out.
    media_url_secret: SecretStr | None = None
    media_url_ttl_seconds: int = 6 * 3600
    # Search (Proposal P-025/P-026): starting points for the evaluation harness to tune.
    # How long a search waits to embed the query before answering with keyword hits only.
    search_embedding_timeout_seconds: float = 5.0
    # Hits taken from each of keyword and semantic search before fusing; also the deepest page.
    search_candidates: int = 100
    # Reciprocal rank fusion constant: larger flattens the gap between top and lower ranks.
    search_rrf_k: int = 60
    # Roughly how much transcript a result's excerpt shows.
    search_excerpt_ms: int = 30_000
    # Largest recording an admin may upload. Q-19 sets no hard cap; this guards the volume.
    max_upload_bytes: int = 10 * 1024**3
    # Largest single tus PATCH. The server holds one in memory, so this bounds a pod's RAM per
    # concurrent upload; clients send smaller chunks (tus-js-client `chunkSize`).
    upload_chunk_max_bytes: int = 64 * 1024**2
    # How long an unfinished upload can be resumed before it is deleted. Keep the worker's
    # UPLOAD_RETENTION_DAYS the same: the worker does the deleting.
    upload_retention_days: int = 3


@lru_cache
def get_settings() -> Settings:
    return Settings()
