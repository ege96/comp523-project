"""Admin accounts. Per D-005 there is one signed-in role: a row in `admins` is an admin."""

from dataclasses import dataclass
from typing import Protocol

from sqlalchemy import delete, func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from swayambhu_api.models import AdminRow
from swayambhu_api.tokens import Identity


@dataclass(frozen=True)
class Admin:
    id: int
    email: str


class AdminStore(Protocol):
    def get_by_identity(self, provider: str, subject: str) -> Admin | None: ...

    def claim_by_email(self, email: str, provider: str, subject: str) -> Admin | None:
        """Link a sign-in to an invited admin whose email matches and who has no sign-in yet."""
        ...

    def add(self, email: str) -> Admin | None:
        """None if an admin with this email already exists."""
        ...

    def remove(self, email: str) -> bool: ...

    def list(self) -> list[Admin]: ...


def find_admin(store: AdminStore, identity: Identity) -> Admin | None:
    """The admin this sign-in belongs to, or None if the person is not an admin.

    An admin is first added by email. Their first sign-in with a *verified* email links
    the Firebase account to the row; from then on only that Firebase account matches.
    """
    admin = store.get_by_identity(identity.provider, identity.subject)
    if admin is not None or not (identity.email and identity.email_verified):
        return admin
    claimed = store.claim_by_email(identity.email, identity.provider, identity.subject)
    if claimed is not None:
        return claimed
    # A concurrent request from the same person may have just claimed the row.
    return store.get_by_identity(identity.provider, identity.subject)


class SqlAlchemyAdminStore:
    """AdminStore on the request's database session. Each write commits on its own."""

    def __init__(self, session: Session) -> None:
        self._session = session

    def get_by_identity(self, provider: str, subject: str) -> Admin | None:
        row = self._session.scalars(
            select(AdminRow).where(
                AdminRow.auth_provider == provider, AdminRow.auth_subject == subject
            )
        ).one_or_none()
        return _admin(row)

    def claim_by_email(self, email: str, provider: str, subject: str) -> Admin | None:
        # One conditional UPDATE, so two concurrent first sign-ins can't both claim the invite.
        row = self._session.scalars(
            update(AdminRow)
            .where(func.lower(AdminRow.email) == func.lower(email), AdminRow.auth_subject.is_(None))
            .values(auth_provider=provider, auth_subject=subject)
            .returning(AdminRow)
        ).one_or_none()
        self._session.commit()
        return _admin(row)

    def add(self, email: str) -> Admin | None:
        row = self._session.scalars(
            insert(AdminRow)
            .values(email=email)
            .on_conflict_do_nothing(index_elements=[func.lower(AdminRow.email)])
            .returning(AdminRow)
        ).one_or_none()
        self._session.commit()
        return _admin(row)

    def remove(self, email: str) -> bool:
        removed = self._session.scalars(
            delete(AdminRow)
            .where(func.lower(AdminRow.email) == func.lower(email))
            .returning(AdminRow.id)
        ).one_or_none()
        self._session.commit()
        return removed is not None

    def list(self) -> list[Admin]:
        rows = self._session.scalars(select(AdminRow).order_by(AdminRow.id))
        return [Admin(row.id, row.email) for row in rows]


def _admin(row: AdminRow | None) -> Admin | None:
    return Admin(row.id, row.email) if row else None
