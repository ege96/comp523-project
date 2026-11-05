"""Database tables, as SQLAlchemy ORM models (Proposal P-010), shared by the API and worker.

The API's Alembic migrations (`services/api/.../migrations/versions`) create these tables; an
API integration test fails if the models and the migrations drift apart. Keep ORM rows inside
the data layer: stores return plain domain objects (like `admins.Admin`), so routes never hold
a live database row.
"""

import uuid
from datetime import date, datetime
from typing import Any

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    Computed,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Identity,
    Index,
    Integer,
    MetaData,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import TSVECTOR, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

# Keyword search folds spellings that mean the same before matching original text: Unicode
# NFC, Devanagari digits to ASCII (२०७२ = 2072), and zero-width (non-)joiners, which only
# change how Devanagari conjuncts are drawn. `swayambhu_api.search.fold_query` is the same
# for queries; change both together, with a migration.
FOLD_SQL = (
    "translate(normalize({}, NFC), "
    "U&'\\0966\\0967\\0968\\0969\\096A\\096B\\096C\\096D\\096E\\096F\\200C\\200D', "
    "'0123456789')"
)

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


# Status-like columns are text + CHECK rather than Postgres ENUMs: a value can be added or
# dropped with an ordinary migration. Proposal P-012, see notes/schema_proposal.md.
VISIBILITIES = ("public", "private")
# No manual review step: a finished transcript is "done" (amends D-008, Eric 2026-11-05).
STATUSES = ("processing", "done", "failed")
TRANSLATION_STATUSES = ("not_needed", "pending", "done", "failed")
DATE_PRECISIONS = ("year", "month", "day")
MEDIA_KINDS = ("original", "playback")
REPRESENTATIONS = ("original", "english")
JOB_KINDS = ("transcribe", "translate", "index", "playback", "retranslate")
JOB_STATES = ("queued", "running", "done", "failed")


def _one_of(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


def _created_at() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), server_default=func.now())


class LanguageRow(Base):
    """Languages an interview or segment can be in. Seeded by migration 0002 with en, ne, new.

    A table rather than a CHECK so a new language is a row, not a schema change (NF8), and the
    filter dropdown can list them with their names.
    """

    __tablename__ = "languages"

    code: Mapped[str] = mapped_column(Text, primary_key=True)  # ISO 639: en, ne, new
    english_name: Mapped[str] = mapped_column(Text)


class IntervieweeRow(Base):
    """The person interviewed: metadata for the interviewee filter, not speaker diarization.

    Names are not unique: two people can share one.
    """

    __tablename__ = "interviewees"

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    display_name: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = _created_at()


class InterviewRow(Base):
    """One recording and its metadata (D-004). Status and visibility are independent (D-008).

    Every query that returns interviews, segments, search hits or media must filter through
    `visibility.visible_to(viewer)`.
    """

    __tablename__ = "interviews"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid()
    )
    title: Mapped[str] = mapped_column(Text)
    visibility: Mapped[str] = mapped_column(Text, server_default="private", index=True)
    status: Mapped[str] = mapped_column(Text, server_default="processing")
    # Why it failed, or which step is running. Admin-only.
    status_detail: Mapped[str | None] = mapped_column(Text)
    translation_status: Mapped[str] = mapped_column(Text, server_default="pending")

    interviewee_id: Mapped[int | None] = mapped_column(
        ForeignKey("interviewees.id", ondelete="SET NULL"), index=True
    )
    # First day of the known period; precision says how much of it is real.
    recorded_on: Mapped[date | None] = mapped_column(Date, index=True)
    recorded_on_precision: Mapped[str | None] = mapped_column(Text)
    interviewer: Mapped[str | None] = mapped_column(Text)
    location: Mapped[str | None] = mapped_column(Text)
    description: Mapped[str | None] = mapped_column(Text)
    consent_note: Mapped[str | None] = mapped_column(Text)

    # The main language: detected by the worker, confirmed or overridden by an admin (D-004).
    # Every language heard in the recording is in interview_languages.
    language_detected: Mapped[str | None] = mapped_column(ForeignKey("languages.code"))
    language_detected_confidence: Mapped[float | None] = mapped_column(Float)
    language_confirmed: Mapped[str | None] = mapped_column(ForeignKey("languages.code"))
    primary_language: Mapped[str | None] = mapped_column(
        Text,
        Computed("COALESCE(language_confirmed, language_detected)", persisted=True),
        index=True,
    )

    # Provenance of the current machine text, e.g. "openai:whisper-1", "google:nmt".
    transcribed_by: Mapped[str | None] = mapped_column(Text)
    translated_by: Mapped[str | None] = mapped_column(Text)

    duration_ms: Mapped[int | None] = mapped_column(Integer)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("admins.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = _created_at()
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        CheckConstraint(_one_of("visibility", VISIBILITIES), name="visibility_valid"),
        CheckConstraint(_one_of("status", STATUSES), name="status_valid"),
        CheckConstraint(
            _one_of("translation_status", TRANSLATION_STATUSES), name="translation_status_valid"
        ),
        CheckConstraint(
            _one_of("recorded_on_precision", DATE_PRECISIONS), name="recorded_on_precision_valid"
        ),
        CheckConstraint(
            "(recorded_on IS NULL) = (recorded_on_precision IS NULL)", name="recorded_on_complete"
        ),
        CheckConstraint("language_detected_confidence BETWEEN 0 AND 1", name="confidence_range"),
        CheckConstraint("duration_ms >= 0", name="duration_nonnegative"),
    )


class InterviewLanguageRow(Base):
    """Every language heard in an interview, so mixed-language recordings match each filter."""

    __tablename__ = "interview_languages"

    interview_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("interviews.id", ondelete="CASCADE"), primary_key=True
    )
    language_code: Mapped[str] = mapped_column(
        ForeignKey("languages.code"), primary_key=True, index=True
    )


class MediaFileRow(Base):
    """A stored media object. `storage_key` is opaque to everything but the storage
    interface (D-007); URLs are minted per request after the visibility check, never stored.
    """

    __tablename__ = "media_files"

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    interview_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("interviews.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(Text)
    storage_key: Mapped[str] = mapped_column(Text)
    content_type: Mapped[str] = mapped_column(Text)
    size_bytes: Mapped[int | None] = mapped_column(BigInteger)
    sha256: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = _created_at()

    __table_args__ = (
        CheckConstraint(_one_of("kind", MEDIA_KINDS), name="kind_valid"),
        UniqueConstraint("interview_id", "kind"),
    )


class SegmentRow(Base):
    """One timestamped transcript line, as shown in the viewer (roughly 5-20 s).

    Machine output and human edits are separate columns, so an edit never overwrites what the
    ASR or translator produced; `*_edited` NULL means unedited. Timestamps are machine-set.
    `english_*` stays NULL for English speech and when translation hasn't run or failed.
    """

    __tablename__ = "segments"

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    interview_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("interviews.id", ondelete="CASCADE"))
    seq: Mapped[int] = mapped_column(Integer)
    start_ms: Mapped[int] = mapped_column(Integer)
    end_ms: Mapped[int] = mapped_column(Integer)
    # NULL means mixed or undetermined, not English.
    language: Mapped[str | None] = mapped_column(ForeignKey("languages.code"))

    original_machine: Mapped[str] = mapped_column(Text)
    original_edited: Mapped[str | None] = mapped_column(Text)
    english_machine: Mapped[str | None] = mapped_column(Text)
    english_edited: Mapped[str | None] = mapped_column(Text)
    original_text: Mapped[str] = mapped_column(
        Text, Computed("COALESCE(original_edited, original_machine)", persisted=True)
    )
    english_text: Mapped[str | None] = mapped_column(
        Text, Computed("COALESCE(english_edited, english_machine)", persisted=True)
    )
    # Keyword search. A generated column can't read another one, so these repeat the COALESCE.
    # Generated columns are STORED (persisted) so they can be indexed.
    # There is no Nepali or Nepal Bhasa stemmer; 'simple' splits Devanagari into words. The
    # text is folded first (FOLD_SQL), and search folds queries the same way.
    original_tsv: Mapped[Any] = mapped_column(
        TSVECTOR,
        Computed(
            "to_tsvector('simple'::regconfig, "
            + FOLD_SQL.format("COALESCE(original_edited, original_machine)")
            + ")",
            persisted=True,
        ),
    )
    # `text.translation_fingerprint` of the original the machine English was made from. When
    # an edit changes the original's words, the English is stale until re-translated.
    english_source_hash: Mapped[str | None] = mapped_column(Text)
    # The same, for the original an admin saw when they last saved `english_edited`.
    english_edit_source_hash: Mapped[str | None] = mapped_column(Text)
    english_tsv: Mapped[Any] = mapped_column(
        TSVECTOR,
        Computed(
            "to_tsvector('english'::regconfig, COALESCE(english_edited, english_machine, ''))",
            persisted=True,
        ),
    )

    edited_by: Mapped[int | None] = mapped_column(ForeignKey("admins.id", ondelete="SET NULL"))
    edited_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        UniqueConstraint("interview_id", "seq"),
        CheckConstraint("start_ms >= 0 AND start_ms < end_ms", name="times_valid"),
        Index("segments_original_tsv_idx", "original_tsv", postgresql_using="gin"),
        Index("segments_english_tsv_idx", "english_tsv", postgresql_using="gin"),
    )


# The chunking strategy the worker builds and search reads (P-014). Rows from any other
# strategy are kept for comparison only.
CHUNKER = "time-60s-v1"


class SearchChunkRow(Base):
    """A run of consecutive segments (roughly 30-90 s) that semantic search embeds as one unit.

    Derived data: the worker rebuilds an interview's chunks whenever its segments change.
    `chunker` names the strategy and its settings, so two strategies can be compared side by
    side on the same transcripts.
    """

    __tablename__ = "search_chunks"

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    interview_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("interviews.id", ondelete="CASCADE"))
    chunker: Mapped[str] = mapped_column(Text)
    first_seq: Mapped[int] = mapped_column(Integer)
    last_seq: Mapped[int] = mapped_column(Integer)
    start_ms: Mapped[int] = mapped_column(Integer)
    end_ms: Mapped[int] = mapped_column(Integer)

    __table_args__ = (
        UniqueConstraint("interview_id", "chunker", "first_seq"),
        CheckConstraint("first_seq <= last_seq", name="seq_range_valid"),
        CheckConstraint("start_ms >= 0 AND start_ms < end_ms", name="times_valid"),
    )


class ChunkEmbeddingRow(Base):
    """A chunk's embedding for one model and one text representation.

    The vector has no fixed dimension, so the model (and its dimension) comes from config and
    changing it needs no migration: embed with the new model, then switch the config. Search
    filters on the configured model. `source_hash` is the hash of the embedded text, so an
    edit makes the row stale. Exact scan for now; no ANN index until the model is chosen.
    """

    __tablename__ = "chunk_embeddings"

    chunk_id: Mapped[int] = mapped_column(
        ForeignKey("search_chunks.id", ondelete="CASCADE"), primary_key=True
    )
    model: Mapped[str] = mapped_column(Text, primary_key=True)
    representation: Mapped[str] = mapped_column(Text, primary_key=True)
    embedding: Mapped[Any] = mapped_column(Vector())
    source_hash: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = _created_at()

    __table_args__ = (
        CheckConstraint(_one_of("representation", REPRESENTATIONS), name="representation_valid"),
    )


class JobRow(Base):
    """A unit of worker work on one interview (Proposal for Q-18: a Postgres table, no broker).

    Workers claim queued jobs with `FOR UPDATE SKIP LOCKED`, so several can run at once.
    A running job whose `heartbeat_at` is older than the worker's lease is reclaimed, which
    covers a pod killed mid-job. A queued job waits while the same step runs for the same
    interview, so one step never runs twice at once on one interview. Each kind enqueues the
    next: transcribe, translate, index; `playback` (the browser-playable copy) runs alongside
    them. `retranslate` refreshes the English of lines whose original an admin edited.
    See `swayambhu_core.jobs`.
    """

    __tablename__ = "jobs"

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    kind: Mapped[str] = mapped_column(Text)
    interview_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("interviews.id", ondelete="CASCADE"))
    state: Mapped[str] = mapped_column(Text, server_default="queued")
    attempts: Mapped[int] = mapped_column(Integer, server_default="0")
    max_attempts: Mapped[int] = mapped_column(Integer, server_default="3")
    run_after: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Last failure, kept after a retry succeeds. Admin-only: provider errors can be verbose.
    last_error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = _created_at()
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint(_one_of("kind", JOB_KINDS), name="kind_valid"),
        CheckConstraint(_one_of("state", JOB_STATES), name="state_valid"),
        CheckConstraint("attempts >= 0 AND max_attempts >= 1", name="attempts_valid"),
        # At most one waiting job per step per interview, so enqueueing twice is harmless.
        # One may wait behind a running one: its inputs changed after that run started.
        Index(
            "jobs_one_queued_idx",
            "interview_id",
            "kind",
            unique=True,
            postgresql_where=text("state = 'queued'"),
        ),
        Index("jobs_queued_idx", "run_after", postgresql_where=text("state = 'queued'")),
        Index("jobs_interview_id_idx", "interview_id"),
    )
