"""Queue search re-indexing for interviews that lack embeddings from the configured model.

Run it where the worker runs, with the same settings, after changing EMBEDDING_PROVIDER,
EMBEDDING_MODEL or EMBEDDING_DIMENSIONS (or the chunker). It only queues `index` jobs; the
worker does the embedding, so this needs no model or API key and returns at once:

    python -m swayambhu_worker.reindex --dry-run   # list what would be queued
    python -m swayambhu_worker.reindex             # queue them
    python -m swayambhu_worker.reindex --all       # every transcribed interview

Interviews with a step already queued or running are skipped: the pipeline indexes them
when it gets there. Until an interview is re-indexed, semantic search can't find it
(keyword search still does), because search only compares vectors from the same model.
"""

import argparse
import uuid

from sqlalchemy import exists, select
from sqlalchemy.orm import Session
from swayambhu_core import jobs
from swayambhu_core.models import (
    CHUNKER,
    ChunkEmbeddingRow,
    InterviewRow,
    JobRow,
    SearchChunkRow,
    SegmentRow,
)
from swayambhu_providers.factory import embedder_name

from swayambhu_worker.config import WorkerSettings
from swayambhu_worker.db import session_factory


def needs_index(session: Session, model: str, *, everything: bool = False) -> list[uuid.UUID]:
    """Transcribed interviews with no current chunks, or a chunk with no vector from `model`."""
    transcribed = exists().where(SegmentRow.interview_id == InterviewRow.id)
    busy = exists().where(
        JobRow.interview_id == InterviewRow.id, JobRow.state.in_(("queued", "running"))
    )
    query = select(InterviewRow.id).where(transcribed, ~busy)
    if not everything:
        chunks = (SearchChunkRow.interview_id == InterviewRow.id) & (
            SearchChunkRow.chunker == CHUNKER
        )
        embedded = exists().where(
            ChunkEmbeddingRow.chunk_id == SearchChunkRow.id, ChunkEmbeddingRow.model == model
        )
        query = query.where(
            ~exists().where(chunks) | exists().where(chunks, ~embedded),
        )
    return list(session.scalars(query.order_by(InterviewRow.created_at)))


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--all", action="store_true", help="re-index every transcribed interview")
    parser.add_argument("--dry-run", action="store_true", help="list, don't queue")
    args = parser.parse_args(argv)

    settings = WorkerSettings()
    model = embedder_name(settings)
    with session_factory(settings)() as session:
        ids = needs_index(session, model, everything=args.all)
        for interview_id in ids:
            print(interview_id)
            if not args.dry_run:
                jobs.enqueue(session, "index", interview_id)
        session.commit()
    verb = "Would queue" if args.dry_run else "Queued"
    print(f"{verb} {len(ids)} interview(s) for indexing with {model}")


if __name__ == "__main__":
    main()
