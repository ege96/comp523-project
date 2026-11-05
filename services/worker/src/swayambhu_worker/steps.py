"""The three pipeline steps, one job kind each: transcribe, then translate, then index.

Steps commit early, and the runner commits at the end; sessions use expire_on_commit=False.
Languages come from the transcriber when it reports them, else from the translator's
detection (from text, so Nepal Bhasa may read as Nepali: admins confirm it, D-004).
Each step reads what the previous one stored, so a failed step is retried on its own
without redoing (and re-paying for) the earlier ones. Each step replaces its own output,
so running it twice is harmless.
"""

import hashlib
import tempfile
import uuid
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session
from swayambhu_core import jobs
from swayambhu_core.chunking import Timed, chunk_segments, chunk_texts
from swayambhu_core.models import (
    CHUNKER,
    ChunkEmbeddingRow,
    InterviewLanguageRow,
    InterviewRow,
    LanguageRow,
    MediaFileRow,
    SearchChunkRow,
    SegmentRow,
)
from swayambhu_core.storage import MediaStore, file_sha256
from swayambhu_core.text import english_is_stale, translation_fingerprint
from swayambhu_providers import AudioClip, Embedder, Transcriber, Translator

from swayambhu_worker import audio

# Providers report languages as ISO 639-1 ("ne"), ISO 639-3 ("nep") or English names.
_LANGUAGE_ALIASES = {
    "eng": "en",
    "english": "en",
    "nep": "ne",
    "npi": "ne",
    "nepali": "ne",
    "newari": "new",
    "nepal bhasa": "new",
    "nepalbhasa": "new",
}


class StepError(Exception):
    """A failure that retrying won't fix, with a message an admin can act on."""


@dataclass(frozen=True)
class Providers:
    transcriber: Transcriber
    translator: Translator
    embedder: Embedder


Heartbeat = Callable[[], None]


def _interview(session: Session, interview_id: uuid.UUID) -> InterviewRow:
    interview = session.get(InterviewRow, interview_id)
    if interview is None:
        raise StepError(f"Interview {interview_id} no longer exists")
    return interview


def _known_language(known: set[str], reported: str | None) -> str | None:
    if not reported:
        return None
    code = reported.strip().lower()
    code = _LANGUAGE_ALIASES.get(code, code)
    return code if code in known else None


def _segments(session: Session, interview_id: uuid.UUID) -> list[SegmentRow]:
    return list(
        session.scalars(
            select(SegmentRow)
            .where(SegmentRow.interview_id == interview_id)
            .order_by(SegmentRow.seq)
        )
    )


def _original_media(session: Session, interview_id: uuid.UUID) -> MediaFileRow:
    media = session.scalar(
        select(MediaFileRow).where(
            MediaFileRow.interview_id == interview_id, MediaFileRow.kind == "original"
        )
    )
    if media is None:
        raise StepError("The interview has no uploaded recording")
    return media


def _record_languages(
    session: Session, interview: InterviewRow, segments: list[SegmentRow]
) -> None:
    """Detected language: the one heard longest. Confidence is its share of the speech whose
    language is known. Every language heard goes into interview_languages for the filters."""
    heard: Counter[str] = Counter()
    for segment in segments:
        if segment.language:
            heard[segment.language] += segment.end_ms - segment.start_ms
    interview.language_detected = interview.language_detected_confidence = None
    if heard:
        language, ms = heard.most_common(1)[0]
        interview.language_detected = language
        interview.language_detected_confidence = round(ms / sum(heard.values()), 3)
    languages = set(heard) | (
        {interview.language_confirmed} if interview.language_confirmed else set()
    )
    session.execute(
        delete(InterviewLanguageRow).where(InterviewLanguageRow.interview_id == interview.id)
    )
    if languages:
        session.execute(
            insert(InterviewLanguageRow)
            .values([{"interview_id": interview.id, "language_code": c} for c in languages])
            .on_conflict_do_nothing()
        )


def transcribe(
    session: Session,
    interview_id: uuid.UUID,
    providers: Providers,
    store: MediaStore,
    heartbeat: Heartbeat,
) -> None:
    interview = _interview(session, interview_id)
    if session.scalar(
        select(SegmentRow.id).where(
            SegmentRow.interview_id == interview_id, SegmentRow.edited_at.is_not(None)
        )
    ):
        raise StepError(
            "Not re-transcribing: an admin has edited this transcript, and replacing it "
            "needs their confirmation."
        )
    media = _original_media(session, interview_id)
    interview.status_detail = "Transcribing"
    hints = [interview.language_confirmed] if interview.language_confirmed else []
    known = set(session.scalars(select(LanguageRow.code)))
    # Commit now: admins see the progress, and no transaction stays open during provider calls.
    session.commit()

    rows: list[SegmentRow] = []
    with store.local_copy(media.storage_key) as source, tempfile.TemporaryDirectory() as tmp:
        total_ms = audio.duration_ms(source)
        for index, piece in enumerate(audio.plan_pieces(total_ms, audio.loudness(source))):
            clip_path = Path(tmp) / f"piece-{index:05d}.flac"
            audio.cut(source, piece, clip_path)
            clip = AudioClip(clip_path, piece.end_ms - piece.start_ms)
            for found in providers.transcriber.transcribe(clip, hints):
                text = found.text.strip()
                start = piece.start_ms + max(0, found.start_ms)
                end = min(piece.end_ms, piece.start_ms + found.end_ms)
                if not text or end <= start:
                    continue
                rows.append(
                    SegmentRow(
                        interview_id=interview_id,
                        seq=len(rows),
                        start_ms=start,
                        end_ms=end,
                        language=_known_language(known, found.language),
                        original_machine=text,
                    )
                )
            clip_path.unlink()
            heartbeat()

    # Replace the old transcript; its chunks and embeddings describe text that's gone.
    session.execute(delete(SearchChunkRow).where(SearchChunkRow.interview_id == interview_id))
    session.execute(delete(SegmentRow).where(SegmentRow.interview_id == interview_id))
    session.add_all(rows)

    _record_languages(session, interview, rows)

    interview.duration_ms = total_ms
    interview.transcribed_by = providers.transcriber.name
    interview.translation_status = "pending"
    interview.translated_by = None
    jobs.enqueue(session, "translate", interview_id)


def _translate_lines(
    session: Session,
    interview: InterviewRow,
    segments: list[SegmentRow],
    providers: Providers,
    heartbeat: Heartbeat,
) -> bool:
    """Machine-translate `segments` to English, grouped by language. Returns False when none
    needed it (all English speech). Records what each English was made from, so an edit to
    the original later shows it as stale (`swayambhu_core.text.english_is_stale`)."""
    known = set(session.scalars(select(LanguageRow.code)))
    by_language: dict[str | None, list[SegmentRow]] = {}
    for segment in segments:
        # Unknown (None) when the transcriber didn't say and no admin has confirmed it.
        source = segment.language or interview.language_confirmed
        if source == "en":
            segment.english_machine = None  # English speech: english_text stays NULL
            segment.english_source_hash = None
        else:
            by_language.setdefault(source, []).append(segment)

    for source, group in by_language.items():
        # None lets the translator detect the language, which also fills in the segment's.
        translations = providers.translator.translate_to_english(
            [s.original_text for s in group], source
        )
        for segment, translation in zip(group, translations, strict=True):
            segment.english_machine = translation.text.strip() or None
            segment.english_source_hash = translation_fingerprint(segment.original_text)
            if source is None:
                segment.language = _known_language(known, translation.detected_language)
                if segment.language == "en":
                    segment.english_machine = segment.english_source_hash = None
        heartbeat()
    if None in by_language:
        _record_languages(session, interview, _segments(session, interview.id))
    return bool(by_language)


def translate(
    session: Session,
    interview_id: uuid.UUID,
    providers: Providers,
    store: MediaStore,
    heartbeat: Heartbeat,
) -> None:
    interview = _interview(session, interview_id)
    interview.status_detail = "Translating"
    session.commit()
    if _translate_lines(session, interview, _segments(session, interview_id), providers, heartbeat):
        interview.translation_status = "done"
        interview.translated_by = providers.translator.name
    else:
        interview.translation_status = "not_needed"
        interview.translated_by = None
    jobs.enqueue(session, "index", interview_id)


def retranslate(
    session: Session,
    interview_id: uuid.UUID,
    providers: Providers,
    store: MediaStore,
    heartbeat: Heartbeat,
) -> None:
    """Refresh the machine English of lines whose original an admin edited since it was made.

    The API queues this a few minutes after the last edit, so a burst of edits costs one
    batch. A human English edit is kept as it is: the machine English under it is refreshed,
    and the edit stays flagged for review (`english_edit_is_stale`) until an admin saves it.
    """
    interview = _interview(session, interview_id)
    stale = [s for s in _segments(session, interview_id) if english_is_stale(s)]
    if not stale:
        return
    _translate_lines(session, interview, stale, providers, heartbeat)
    interview.translated_by = providers.translator.name
    jobs.enqueue(session, "index", interview_id)


def give_up_translating(session: Session, interview_id: uuid.UUID, error: str) -> None:
    """English is allowed to fail (F13): index what there is and leave the gap visible."""
    interview = _interview(session, interview_id)
    interview.translation_status = "failed"
    interview.status_detail = f"Translation failed: {error}"
    jobs.enqueue(session, "index", interview_id)


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def index(
    session: Session,
    interview_id: uuid.UUID,
    providers: Providers,
    store: MediaStore,
    heartbeat: Heartbeat,
) -> None:
    """Group segments into search chunks and embed them with the configured model.

    Incremental: a chunk whose boundaries haven't changed keeps its row, and an embedding
    whose text hash still matches is kept, so after an admin edits one line only that line's
    chunk is embedded again. Embeddings from other models are left for comparison.
    """
    interview = _interview(session, interview_id)
    if interview.translation_status != "failed":
        interview.status_detail = "Indexing for search"
    segments = _segments(session, interview_id)
    by_seq = {s.seq: s for s in segments}
    model = providers.embedder.name

    existing = {
        (c.first_seq, c.last_seq, c.start_ms, c.end_ms): c
        for c in session.scalars(
            select(SearchChunkRow).where(
                SearchChunkRow.interview_id == interview_id, SearchChunkRow.chunker == CHUNKER
            )
        )
    }
    planned: list[tuple[SearchChunkRow, dict[str, str]]] = []
    for chunk in chunk_segments([Timed(s.seq, s.start_ms, s.end_ms) for s in segments]):
        key = (chunk.first_seq, chunk.last_seq, chunk.start_ms, chunk.end_ms)
        row = existing.pop(key, None)
        if row is None:
            row = SearchChunkRow(
                interview_id=interview_id,
                chunker=CHUNKER,
                first_seq=chunk.first_seq,
                last_seq=chunk.last_seq,
                start_ms=chunk.start_ms,
                end_ms=chunk.end_ms,
            )
            session.add(row)
        members = [by_seq[seq] for seq in range(chunk.first_seq, chunk.last_seq + 1)]
        planned.append((row, chunk_texts(members, interview)))
    if existing:  # chunks that no longer match the segments, with all their embeddings
        session.execute(
            delete(SearchChunkRow).where(SearchChunkRow.id.in_(c.id for c in existing.values()))
        )
    session.flush()  # assigns new chunk ids

    # Hashes only: the vectors themselves aren't needed to tell what changed.
    stored: dict[tuple[int, str], str] = {
        (chunk_id, representation): source_hash
        for chunk_id, representation, source_hash in session.execute(
            select(
                ChunkEmbeddingRow.chunk_id,
                ChunkEmbeddingRow.representation,
                ChunkEmbeddingRow.source_hash,
            ).where(
                ChunkEmbeddingRow.model == model,
                ChunkEmbeddingRow.chunk_id.in_(row.id for row, _ in planned),
            )
        )
    }
    pending: list[tuple[int, str, str]] = []  # chunk id, representation, text
    for row, texts in planned:
        for representation, text in texts.items():
            if stored.pop((row.id, representation), None) != _sha256(text):
                pending.append((row.id, representation, text))
    for chunk_id, representation in stored:  # e.g. the English text is now empty
        session.execute(
            delete(ChunkEmbeddingRow).where(
                ChunkEmbeddingRow.chunk_id == chunk_id,
                ChunkEmbeddingRow.model == model,
                ChunkEmbeddingRow.representation == representation,
            )
        )

    if pending:
        vectors = providers.embedder.embed([text for _, _, text in pending], "passage")
        for (chunk_id, representation, text), vector in zip(pending, vectors, strict=True):
            session.execute(
                insert(ChunkEmbeddingRow)
                .values(
                    chunk_id=chunk_id,
                    model=model,
                    representation=representation,
                    embedding=vector,
                    source_hash=_sha256(text),
                )
                .on_conflict_do_update(
                    index_elements=["chunk_id", "model", "representation"],
                    set_={
                        "embedding": vector,
                        "source_hash": _sha256(text),
                        "created_at": func.now(),
                    },
                )
            )
        heartbeat()

    interview.status = "done"
    if interview.translation_status != "failed":
        interview.status_detail = None


def playback(
    session: Session,
    interview_id: uuid.UUID,
    providers: Providers,
    store: MediaStore,
    heartbeat: Heartbeat,
) -> None:
    """Make the copy the player streams. Independent of the transcript steps."""
    _interview(session, interview_id)
    original = _original_media(session, interview_id)
    session.commit()
    with store.local_copy(original.storage_key) as source, tempfile.TemporaryDirectory() as tmp:
        made, content_type = audio.make_playback(source, Path(tmp) / "playback", heartbeat)
        key = f"interviews/{interview_id}/playback{made.suffix}"
        store.put(key, made)
        size = made.stat().st_size
        digest = file_sha256(made)

    old = session.scalar(
        select(MediaFileRow).where(
            MediaFileRow.interview_id == interview_id, MediaFileRow.kind == "playback"
        )
    )
    if old is not None:
        if old.storage_key != key:
            store.delete(old.storage_key)
        session.delete(old)
        session.flush()
    session.add(
        MediaFileRow(
            interview_id=interview_id,
            kind="playback",
            storage_key=key,
            content_type=content_type,
            size_bytes=size,
            sha256=digest,
        )
    )


def give_up_retranslating(session: Session, interview_id: uuid.UUID, error: str) -> None:
    """The edited lines keep their old English and still show as out of date, so an admin
    can retry with "Update English now"."""
    interview = _interview(session, interview_id)
    interview.status_detail = f"Updating the English failed: {error}"


def give_up_playback(session: Session, interview_id: uuid.UUID, error: str) -> None:
    """The transcript is still usable without a player, so the status stays as it is."""
    interview = _interview(session, interview_id)
    interview.status_detail = f"Playback copy failed: {error}"


def give_up(session: Session, interview_id: uuid.UUID, error: str) -> None:
    """Transcription or indexing failed for good: show it to admins (D-008 "Failed")."""
    interview = session.get(InterviewRow, interview_id)
    if interview is not None:
        interview.status = "failed"
        interview.status_detail = error


Step = Callable[[Session, uuid.UUID, Providers, MediaStore, Heartbeat], None]
STEPS: dict[str, Step] = {
    "transcribe": transcribe,
    "translate": translate,
    "index": index,
    "playback": playback,
    "retranslate": retranslate,
}
GIVE_UP: dict[str, Callable[[Session, uuid.UUID, str], None]] = {
    "transcribe": give_up,
    "translate": give_up_translating,
    "index": give_up,
    "playback": give_up_playback,
    "retranslate": give_up_retranslating,
}
