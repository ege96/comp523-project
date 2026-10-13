from pydantic_settings import BaseSettings, SettingsConfigDict


class WorkerSettings(BaseSettings):
    """Worker settings, read from environment variables (Proposal: names not yet agreed)."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql://swayambhu@localhost:5432/swayambhu"
    poll_interval_seconds: float = 5.0
