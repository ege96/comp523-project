"""Database tables, as SQLAlchemy ORM models (Proposal P-010).

Alembic migrations in `migrations/versions` create these tables; an integration test fails if
the models and the migrations drift apart. Keep ORM rows inside the data layer: stores return
plain domain objects (like `admins.Admin`), so routes never hold a live database row.
"""

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    Identity,
    Index,
    MetaData,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

# Postgres's own default names, so constraints created by raw SQL before the ORM keep their names.
NAMING_CONVENTION = {
    "pk": "%(table_name)s_pkey",
    "fk": "%(table_name)s_%(column_0_N_name)s_fkey",
    "uq": "%(table_name)s_%(column_0_N_name)s_key",
    "ck": "%(table_name)s_%(constraint_name)s",
    "ix": "%(table_name)s_%(column_0_N_name)s_idx",
}


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)


class AdminRow(Base):
    """D-005: the only signed-in role. Anonymous visitors have no row.

    An admin is invited by email; auth_provider/auth_subject are filled in on their first
    verified sign-in and are what identify them afterwards (Firebase uid today).
    """

    __tablename__ = "admins"

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    email: Mapped[str] = mapped_column(Text)
    auth_provider: Mapped[str | None] = mapped_column(Text)
    auth_subject: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        CheckConstraint(
            "(auth_provider IS NULL) = (auth_subject IS NULL)",
            name="identity_complete",
        ),
        UniqueConstraint("auth_provider", "auth_subject", name="admins_identity_unique"),
        Index("admins_email_unique", func.lower(email), unique=True),
    )
