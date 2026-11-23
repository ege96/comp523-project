"""Signed media links, without a database."""

from pydantic import SecretStr

from swayambhu_api import media_urls
from swayambhu_api.config import Settings

SETTINGS = Settings(media_url_secret=SecretStr("test-secret"), media_url_ttl_seconds=6 * 3600)
STEP = media_urls.EXPIRY_STEP_SECONDS


def test_fetches_within_the_same_hour_get_the_same_link() -> None:
    # A changed link makes the player reload the file from the start.
    start = 10 * STEP + 1
    first = media_urls.signed_url(SETTINGS, 7, "admin", now=start)
    assert media_urls.signed_url(SETTINGS, 7, "admin", now=start + STEP - 2) == first
    assert media_urls.signed_url(SETTINGS, 7, "admin", now=start + STEP)[0] != first[0]


def test_a_link_lasts_at_least_the_ttl_and_at_most_one_step_longer() -> None:
    for now in (10 * STEP, 10 * STEP + 1, 11 * STEP - 1):
        expires = media_urls.signed_url(SETTINGS, 7, "public", now=now)[1]
        assert now + SETTINGS.media_url_ttl_seconds <= expires
        assert expires < now + SETTINGS.media_url_ttl_seconds + STEP
        assert expires % STEP == 0
