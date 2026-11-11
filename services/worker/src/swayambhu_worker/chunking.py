"""Grouping display segments into search chunks. Sizes are first guesses for the
evaluation harness to tune; a new strategy gets a new name (`swayambhu_core.models.CHUNKER`)
so both can be compared."""

from dataclasses import dataclass

TARGET_MS = 60_000
MIN_MS = 30_000
MAX_MS = 90_000


@dataclass(frozen=True)
class Timed:
    seq: int
    start_ms: int
    end_ms: int


@dataclass(frozen=True)
class Chunk:
    first_seq: int
    last_seq: int
    start_ms: int
    end_ms: int


def chunk_segments(segments: list[Timed]) -> list[Chunk]:
    """Consecutive, non-overlapping runs of about TARGET_MS. A short tail joins the previous
    chunk when the result stays under MAX_MS."""
    chunks: list[Chunk] = []
    run: list[Timed] = []
    for segment in segments:
        run.append(segment)
        if run[-1].end_ms - run[0].start_ms >= TARGET_MS:
            chunks.append(Chunk(run[0].seq, run[-1].seq, run[0].start_ms, run[-1].end_ms))
            run = []
    if run:
        tail = Chunk(run[0].seq, run[-1].seq, run[0].start_ms, run[-1].end_ms)
        last = chunks[-1] if chunks else None
        if last and tail.end_ms - tail.start_ms < MIN_MS and tail.end_ms - last.start_ms <= MAX_MS:
            chunks[-1] = Chunk(last.first_seq, tail.last_seq, last.start_ms, tail.end_ms)
        else:
            chunks.append(tail)
    return chunks
