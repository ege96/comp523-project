"""Grouping display segments into search chunks (P-014), and the text each chunk embeds.
Shared by the worker, which indexes, and the API's search evaluation, which indexes a test
set the same way. Sizes are first guesses for the evaluation to tune; a new strategy gets a
new name (`swayambhu_core.models.CHUNKER`) so both can be compared."""

from dataclasses import dataclass

from swayambhu_core.models import InterviewRow, SegmentRow

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


def source_language(segment: SegmentRow, interview: InterviewRow) -> str | None:
    return segment.language or interview.language_confirmed or interview.language_detected


def chunk_texts(members: list[SegmentRow], interview: InterviewRow) -> dict[str, str]:
    """The text each representation embeds for one chunk. English speech counts as English;
    "original" is left out when the chunk is all English."""
    english_speech = [source_language(s, interview) == "en" for s in members]
    english = " ".join(
        s.original_text if is_en else (s.english_text or "")
        for s, is_en in zip(members, english_speech, strict=True)
    ).strip()
    texts = {}
    if english:
        texts["english"] = english
    if not all(english_speech):
        texts["original"] = " ".join(s.original_text for s in members)
    return texts
