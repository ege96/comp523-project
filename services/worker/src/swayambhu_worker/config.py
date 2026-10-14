from pathlib import Path

from pydantic_settings import SettingsConfigDict
from swayambhu_providers.settings import ProviderSettings


class WorkerSettings(ProviderSettings):
    """Worker settings, read from environment variables, then `.env` in the working directory
    (Proposal: names not yet agreed). AI provider settings come from ProviderSettings."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql://swayambhu@localhost:5432/swayambhu"
    poll_interval_seconds: float = 5.0
    # Where LocalMediaStore keeps uploads (D-007). The API must see the same directory.
    media_root: Path = Path("/data/media")
    # A running job whose worker hasn't heartbeated for this long is taken over by another.
    job_lease_seconds: float = 600.0
