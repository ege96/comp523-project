"""Admin accounts. Per D-005 there is one signed-in role: a row in `admins` is an admin."""

from dataclasses import dataclass
from typing import Protocol

import psycopg

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


class PostgresAdminStore:
    def __init__(self, database_url: str, connect_timeout: int) -> None:
        self._database_url = database_url
        self._connect_timeout = connect_timeout

    def _connect(self) -> psycopg.Connection[tuple[int, str]]:
        return psycopg.connect(self._database_url, connect_timeout=self._connect_timeout)

    def get_by_identity(self, provider: str, subject: str) -> Admin | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT id, email FROM admins WHERE auth_provider = %s AND auth_subject = %s",
                (provider, subject),
            ).fetchone()
        return Admin(*row) if row else None

    def claim_by_email(self, email: str, provider: str, subject: str) -> Admin | None:
        with self._connect() as conn:
            row = conn.execute(
                "UPDATE admins SET auth_provider = %s, auth_subject = %s"
                " WHERE lower(email) = lower(%s) AND auth_subject IS NULL"
                " RETURNING id, email",
                (provider, subject, email),
            ).fetchone()
        return Admin(*row) if row else None

    def add(self, email: str) -> Admin | None:
        with self._connect() as conn:
            row = conn.execute(
                "INSERT INTO admins (email) VALUES (%s)"
                " ON CONFLICT ((lower(email))) DO NOTHING RETURNING id, email",
                (email,),
            ).fetchone()
        return Admin(*row) if row else None

    def remove(self, email: str) -> bool:
        with self._connect() as conn:
            cur = conn.execute("DELETE FROM admins WHERE lower(email) = lower(%s)", (email,))
            return cur.rowcount > 0

    def list(self) -> list[Admin]:
        with self._connect() as conn:
            rows = conn.execute("SELECT id, email FROM admins ORDER BY id").fetchall()
        return [Admin(*row) for row in rows]
