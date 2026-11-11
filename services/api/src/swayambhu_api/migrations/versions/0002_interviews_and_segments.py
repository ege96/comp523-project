"""Interviews, transcript segments, search chunks and embeddings.

Design and reasoning: notes/schema_proposal.md in the project files. All new tables, so the
previous release keeps working while this runs (the API migrates on startup).

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-13
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from pgvector.sqlalchemy import Vector
from sqlalchemy.dialects import postgresql

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "interviewees",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=True), nullable=False),
        sa.Column("display_name", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("interviewees_pkey")),
    )
    op.create_table(
        "languages",
        sa.Column("code", sa.Text(), nullable=False),
        sa.Column("english_name", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("code", name=op.f("languages_pkey")),
    )
    op.create_table(
        "interviews",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("visibility", sa.Text(), server_default="private", nullable=False),
        sa.Column("status", sa.Text(), server_default="processing", nullable=False),
        sa.Column("status_detail", sa.Text(), nullable=True),
        sa.Column("translation_status", sa.Text(), server_default="pending", nullable=False),
        sa.Column("interviewee_id", sa.BigInteger(), nullable=True),
        sa.Column("recorded_on", sa.Date(), nullable=True),
        sa.Column("recorded_on_precision", sa.Text(), nullable=True),
        sa.Column("interviewer", sa.Text(), nullable=True),
        sa.Column("location", sa.Text(), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("consent_note", sa.Text(), nullable=True),
        sa.Column("language_detected", sa.Text(), nullable=True),
        sa.Column("language_detected_confidence", sa.Float(), nullable=True),
        sa.Column("language_confirmed", sa.Text(), nullable=True),
        sa.Column(
            "primary_language",
            sa.Text(),
            sa.Computed(
                "COALESCE(language_confirmed, language_detected)",
                persisted=True,
            ),
            nullable=True,
        ),
        sa.Column("transcribed_by", sa.Text(), nullable=True),
        sa.Column("translated_by", sa.Text(), nullable=True),
        sa.Column("duration_ms", sa.Integer(), nullable=True),
        sa.Column("created_by", sa.BigInteger(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "recorded_on_precision IN ('year', 'month', 'day')",
            name=op.f("interviews_recorded_on_precision_valid"),
        ),
        sa.CheckConstraint(
            "status IN ('processing', 'needs_review', 'reviewed', 'failed')",
            name=op.f("interviews_status_valid"),
        ),
        sa.CheckConstraint(
            "translation_status IN ('not_needed', 'pending', 'done', 'failed')",
            name=op.f("interviews_translation_status_valid"),
        ),
        sa.CheckConstraint(
            "visibility IN ('public', 'private')", name=op.f("interviews_visibility_valid")
        ),
        sa.CheckConstraint(
            "(recorded_on IS NULL) = (recorded_on_precision IS NULL)",
            name=op.f("interviews_recorded_on_complete"),
        ),
        sa.CheckConstraint("duration_ms >= 0", name=op.f("interviews_duration_nonnegative")),
        sa.CheckConstraint(
            "language_detected_confidence BETWEEN 0 AND 1", name=op.f("interviews_confidence_range")
        ),
        sa.ForeignKeyConstraint(
            ["created_by"],
            ["admins.id"],
            name=op.f("interviews_created_by_fkey"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["interviewee_id"],
            ["interviewees.id"],
            name=op.f("interviews_interviewee_id_fkey"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["language_confirmed"],
            ["languages.code"],
            name=op.f("interviews_language_confirmed_fkey"),
        ),
        sa.ForeignKeyConstraint(
            ["language_detected"],
            ["languages.code"],
            name=op.f("interviews_language_detected_fkey"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("interviews_pkey")),
    )
    op.create_index(
        op.f("interviews_interviewee_id_idx"), "interviews", ["interviewee_id"], unique=False
    )
    op.create_index(
        op.f("interviews_primary_language_idx"), "interviews", ["primary_language"], unique=False
    )
    op.create_index(op.f("interviews_recorded_on_idx"), "interviews", ["recorded_on"], unique=False)
    op.create_index(op.f("interviews_visibility_idx"), "interviews", ["visibility"], unique=False)
    op.create_table(
        "interview_languages",
        sa.Column("interview_id", sa.UUID(), nullable=False),
        sa.Column("language_code", sa.Text(), nullable=False),
        sa.ForeignKeyConstraint(
            ["interview_id"],
            ["interviews.id"],
            name=op.f("interview_languages_interview_id_fkey"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["language_code"],
            ["languages.code"],
            name=op.f("interview_languages_language_code_fkey"),
        ),
        sa.PrimaryKeyConstraint(
            "interview_id", "language_code", name=op.f("interview_languages_pkey")
        ),
    )
    op.create_index(
        op.f("interview_languages_language_code_idx"),
        "interview_languages",
        ["language_code"],
        unique=False,
    )
    op.create_table(
        "media_files",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=True), nullable=False),
        sa.Column("interview_id", sa.UUID(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("storage_key", sa.Text(), nullable=False),
        sa.Column("content_type", sa.Text(), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=True),
        sa.Column("sha256", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("kind IN ('original', 'playback')", name=op.f("media_files_kind_valid")),
        sa.ForeignKeyConstraint(
            ["interview_id"],
            ["interviews.id"],
            name=op.f("media_files_interview_id_fkey"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("media_files_pkey")),
        sa.UniqueConstraint("interview_id", "kind", name=op.f("media_files_interview_id_kind_key")),
    )
    op.create_table(
        "search_chunks",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=True), nullable=False),
        sa.Column("interview_id", sa.UUID(), nullable=False),
        sa.Column("chunker", sa.Text(), nullable=False),
        sa.Column("first_seq", sa.Integer(), nullable=False),
        sa.Column("last_seq", sa.Integer(), nullable=False),
        sa.Column("start_ms", sa.Integer(), nullable=False),
        sa.Column("end_ms", sa.Integer(), nullable=False),
        sa.CheckConstraint("first_seq <= last_seq", name=op.f("search_chunks_seq_range_valid")),
        sa.CheckConstraint(
            "start_ms >= 0 AND start_ms < end_ms", name=op.f("search_chunks_times_valid")
        ),
        sa.ForeignKeyConstraint(
            ["interview_id"],
            ["interviews.id"],
            name=op.f("search_chunks_interview_id_fkey"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("search_chunks_pkey")),
        sa.UniqueConstraint(
            "interview_id",
            "chunker",
            "first_seq",
            name=op.f("search_chunks_interview_id_chunker_first_seq_key"),
        ),
    )
    op.create_table(
        "segments",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=True), nullable=False),
        sa.Column("interview_id", sa.UUID(), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("start_ms", sa.Integer(), nullable=False),
        sa.Column("end_ms", sa.Integer(), nullable=False),
        sa.Column("language", sa.Text(), nullable=True),
        sa.Column("original_machine", sa.Text(), nullable=False),
        sa.Column("original_edited", sa.Text(), nullable=True),
        sa.Column("english_machine", sa.Text(), nullable=True),
        sa.Column("english_edited", sa.Text(), nullable=True),
        sa.Column(
            "original_text",
            sa.Text(),
            sa.Computed(
                "COALESCE(original_edited, original_machine)",
                persisted=True,
            ),
            nullable=False,
        ),
        sa.Column(
            "english_text",
            sa.Text(),
            sa.Computed(
                "COALESCE(english_edited, english_machine)",
                persisted=True,
            ),
            nullable=True,
        ),
        sa.Column(
            "original_tsv",
            postgresql.TSVECTOR(),
            sa.Computed(
                "to_tsvector('simple'::regconfig, COALESCE(original_edited, original_machine))",
                persisted=True,
            ),
            nullable=False,
        ),
        sa.Column(
            "english_tsv",
            postgresql.TSVECTOR(),
            sa.Computed(
                "to_tsvector('english'::regconfig, COALESCE(english_edited, english_machine, ''))",
                persisted=True,
            ),
            nullable=False,
        ),
        sa.Column("edited_by", sa.BigInteger(), nullable=True),
        sa.Column("edited_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "start_ms >= 0 AND start_ms < end_ms", name=op.f("segments_times_valid")
        ),
        sa.ForeignKeyConstraint(
            ["edited_by"], ["admins.id"], name=op.f("segments_edited_by_fkey"), ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(
            ["interview_id"],
            ["interviews.id"],
            name=op.f("segments_interview_id_fkey"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["language"], ["languages.code"], name=op.f("segments_language_fkey")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("segments_pkey")),
        sa.UniqueConstraint("interview_id", "seq", name=op.f("segments_interview_id_seq_key")),
    )
    op.create_index(
        "segments_english_tsv_idx",
        "segments",
        ["english_tsv"],
        unique=False,
        postgresql_using="gin",
    )
    op.create_index(
        "segments_original_tsv_idx",
        "segments",
        ["original_tsv"],
        unique=False,
        postgresql_using="gin",
    )
    op.create_table(
        "chunk_embeddings",
        sa.Column("chunk_id", sa.BigInteger(), nullable=False),
        sa.Column("model", sa.Text(), nullable=False),
        sa.Column("representation", sa.Text(), nullable=False),
        sa.Column("embedding", Vector(), nullable=False),
        sa.Column("source_hash", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "representation IN ('original', 'english')",
            name=op.f("chunk_embeddings_representation_valid"),
        ),
        sa.ForeignKeyConstraint(
            ["chunk_id"],
            ["search_chunks.id"],
            name=op.f("chunk_embeddings_chunk_id_fkey"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint(
            "chunk_id", "model", "representation", name=op.f("chunk_embeddings_pkey")
        ),
    )
    op.bulk_insert(
        sa.table("languages", sa.column("code", sa.Text()), sa.column("english_name", sa.Text())),
        [
            {"code": "en", "english_name": "English"},
            {"code": "ne", "english_name": "Nepali"},
            {"code": "new", "english_name": "Nepal Bhasa"},
        ],
    )


def downgrade() -> None:
    op.drop_table("chunk_embeddings")
    op.drop_index("segments_original_tsv_idx", table_name="segments", postgresql_using="gin")
    op.drop_index("segments_english_tsv_idx", table_name="segments", postgresql_using="gin")
    op.drop_table("segments")
    op.drop_table("search_chunks")
    op.drop_table("media_files")
    op.drop_index(op.f("interview_languages_language_code_idx"), table_name="interview_languages")
    op.drop_table("interview_languages")
    op.drop_index(op.f("interviews_visibility_idx"), table_name="interviews")
    op.drop_index(op.f("interviews_recorded_on_idx"), table_name="interviews")
    op.drop_index(op.f("interviews_primary_language_idx"), table_name="interviews")
    op.drop_index(op.f("interviews_interviewee_id_idx"), table_name="interviews")
    op.drop_table("interviews")
    op.drop_table("languages")
    op.drop_table("interviewees")
