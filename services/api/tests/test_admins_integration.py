from collections.abc import Iterator

import pytest
from sqlalchemy import delete
from sqlalchemy.orm import Session

from swayambhu_api.admins import SqlAlchemyAdminStore, find_admin
from swayambhu_api.models import AdminRow
from swayambhu_api.tokens import Identity

pytestmark = pytest.mark.integration


@pytest.fixture
def store(db_session: Session) -> Iterator[SqlAlchemyAdminStore]:
    db_session.execute(delete(AdminRow))
    db_session.commit()
    yield SqlAlchemyAdminStore(db_session)
    db_session.rollback()
    db_session.execute(delete(AdminRow))
    db_session.commit()


def identity(subject: str, email: str, verified: bool = True) -> Identity:
    return Identity("firebase", subject, email, verified)


def test_invite_claim_and_lookup(store: SqlAlchemyAdminStore) -> None:
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


def test_writes_are_committed(store: SqlAlchemyAdminStore, db_session: Session) -> None:
    added = store.add("a@example.org")
    assert added is not None
    # A separate connection sees the row, so it didn't stay in an open transaction.
    other = Session(db_session.get_bind())
    try:
        assert other.get(AdminRow, added.id) is not None
    finally:
        other.close()
