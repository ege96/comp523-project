from collections.abc import Iterator

import psycopg
import pytest

from swayambhu_api.admins import PostgresAdminStore, find_admin
from swayambhu_api.config import Settings
from swayambhu_api.tokens import Identity

pytestmark = pytest.mark.integration


@pytest.fixture
def store() -> Iterator[PostgresAdminStore]:
    settings = Settings()
    with psycopg.connect(settings.database_url) as conn:
        conn.execute("DELETE FROM admins")
    yield PostgresAdminStore(settings.database_url, settings.db_connect_timeout_seconds)
    with psycopg.connect(settings.database_url) as conn:
        conn.execute("DELETE FROM admins")


def identity(subject: str, email: str, verified: bool = True) -> Identity:
    return Identity("firebase", subject, email, verified)


def test_invite_claim_and_lookup(store: PostgresAdminStore) -> None:
    added = store.add("Lead@Example.org")
    assert added is not None
    assert store.add("lead@example.org") is None  # case-insensitive duplicate

    assert find_admin(store, identity("uid-1", "lead@example.org", verified=False)) is None
    assert find_admin(store, identity("uid-1", "lead@example.org")) == added
    # Linked: found by uid even if the Firebase email changes, and the invite can't be re-claimed.
    assert find_admin(store, identity("uid-1", "renamed@example.org")) == added
    assert find_admin(store, identity("uid-2", "lead@example.org")) is None

    assert store.list() == [added]
    assert store.remove("LEAD@example.org") is True
    assert store.remove("lead@example.org") is False
    assert find_admin(store, identity("uid-1", "lead@example.org")) is None
