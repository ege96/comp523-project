"""The three pipeline steps, one job kind each: transcribe, then translate, then index.

Steps commit early, and the runner commits at the end; sessions use expire_on_commit=False.
Languages come from the transcriber when it reports them, else from the translator's
detection (from text, so Nepal Bhasa may read as Nepali: admins confirm it).
Steps read persisted outputs so a retry can restart the failed step.
"""

import hashlib
import tempfile
import uuid
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from sqlalchemy import delete, func, select, tuple_
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session
from swayambhu_core import jobs, transcripts
from swayambhu_core.languages import sync_interview_languages
from swayambhu_core.models import (
    CHUNKER,
    ChunkEmbeddingRow,
    InterviewRow,
    LanguageRow,
    MediaFileRow,
    SearchChunkRow,
    SegmentRow,
)
from swayambhu_core.storage import MediaStore, file_sha256
from swayambhu_core.text import english_is_stale, translation_fingerprint
from swayambhu_providers import AudioClip, Embedder, Transcriber, Translation, Translator

from swayambhu_worker import audio
from swayambhu_worker.chunking import Timed, chunk_segments

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

PLAYBACK_FAILED = "Playback copy failed"


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


def _segments(
    session: Session, interview_id: uuid.UUID, *, fresh: bool = False
) -> list[SegmentRow]:
    """The interview's lines in order. `fresh` reloads lines already in the session, to see
    what admins saved since they were read."""
    query = select(SegmentRow).where(SegmentRow.interview_id == interview_id)
    if fresh:
        query = query.execution_options(populate_existing=True)
    return list(session.scalars(query.order_by(SegmentRow.seq)))


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
    language is known. The filters' languages are rewritten from the stored lines and the
    confirmed language as it is when this commits (`sync_interview_languages`)."""
    heard: Counter[str] = Counter()
    for segment in segments:
        if segment.language:
            heard[segment.language] += segment.end_ms - segment.start_ms
    interview.language_detected = interview.language_detected_confidence = None
    if heard:
        language, ms = heard.most_common(1)[0]
        interview.language_detected = language
        interview.language_detected_confidence = round(ms / sum(heard.values()), 3)
    sync_interview_languages(session, interview.id)


def _refuse_to_replace_corrections(
    session: Session, interview_id: uuid.UUID, approved_at: datetime | None
) -> None:
    corrected = transcripts.corrections_blocking_replacement(session, interview_id, approved_at)
    if not corrected:
        return
    if approved_at is None:
        raise StepError(
            "Not transcribed again: admins have corrected lines of this transcript. To "
            "replace them, press Transcribe again on this page and confirm."
        )
    raise StepError(
        f"Not transcribed again: {corrected} corrected line(s) were saved after replacing the "
        "transcript was confirmed, and are kept. To replace them too, press Transcribe again "
        "on this page and confirm."
    )


def transcribe(
    session: Session,
    interview_id: uuid.UUID,
    providers: Providers,
    store: MediaStore,
    heartbeat: Heartbeat,
    *,
    replace_edits: bool = False,
) -> None:
    """Replace the transcript with a new one. Corrected lines block it, unless an admin
    confirmed replacing them (`retranscribe`), and then only the lines corrected before that
    confirmation may go (`swayambhu_core.transcripts`)."""
    interview = _interview(session, interview_id)
    approved_at = (
        transcripts.replacement_approved_at(session, interview_id) if replace_edits else None
    )
    _refuse_to_replace_corrections(session, interview_id, approved_at)
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
    if not rows:
        raise StepError(
            "The transcription service returned no text for this recording, so any "
            "existing transcript was kept."
        )

    # Checked again under the lock that edits take: a line corrected while this ran is kept.
    transcripts.lock_interview(session, interview_id)
    _refuse_to_replace_corrections(session, interview_id, approved_at)
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


def retranscribe(
    session: Session,
    interview_id: uuid.UUID,
    providers: Providers,
    store: MediaStore,
    heartbeat: Heartbeat,
) -> None:
    """Transcribe again although admins corrected lines: they confirmed losing the
    corrections, say after fixing the language."""
    transcribe(session, interview_id, providers, store, heartbeat, replace_edits=True)


def _source_language(segment: SegmentRow, interview: InterviewRow) -> str | None:
    return segment.language or interview.language_confirmed or interview.language_detected


@dataclass(frozen=True)
class _Line:
    segment_id: int
    text: str  # the original as it was sent for translation
    fingerprint: str


@dataclass(frozen=True)
class _Translated:
    lines: int  # lines looked at, English speech included
    needed: int  # lines sent for translation
    usable: int  # of those, lines that came back with English


def _translate_lines(
    session: Session,
    interview_id: uuid.UUID,
    providers: Providers,
    heartbeat: Heartbeat,
    *,
    only_stale: bool,
) -> _Translated:
    """Machine-translate the lines to English (only those whose English is out of date, with
    `only_stale`), grouped by language.

    The originals are read, the transaction ends, the translator runs, and the results are
    written to the lines as they are then. Each English records the fingerprint of the text
    it was made from, so a line an admin edited meanwhile shows as out of date
    (`swayambhu_core.text.english_is_stale`) and a `retranslate` is queued for it.
    """
    interview = _interview(session, interview_id)
    known = set(session.scalars(select(LanguageRow.code)))
    segments = _segments(session, interview_id, fresh=True)
    if only_stale:
        segments = [s for s in segments if english_is_stale(s)]
    english_speech: list[int] = []
    groups: dict[str | None, list[_Line]] = {}
    for segment in segments:
        # Unknown (None) when the transcriber didn't say and no admin has confirmed it.
        source = segment.language or interview.language_confirmed
        if source == "en":
            english_speech.append(segment.id)
        else:
            text = segment.original_edited or segment.original_machine
            line = _Line(segment.id, text, translation_fingerprint(text))
            groups.setdefault(source, []).append(line)
    session.commit()  # no transaction stays open during provider calls

    results: list[tuple[_Line, Translation, str | None]] = []
    for source, lines in groups.items():
        # None lets the translator detect the language, which also fills in the segment's.
        texts = [line.text for line in lines]
        translations = providers.translator.translate_to_english(texts, source)
        results += [(line, t, source) for line, t in zip(lines, translations, strict=True)]
        heartbeat()

    transcripts.lock_interview(session, interview_id)
    current = {
        s.id: s
        for s in session.scalars(
            select(SegmentRow)
            .where(SegmentRow.id.in_([s.id for s in segments]))
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    }  # a line missing here was replaced by a new transcript meanwhile
    for segment_id in english_speech:
        if spoken := current.get(segment_id):
            spoken.english_machine = None  # English speech: english_text stays NULL
            spoken.english_source_hash = None
    detected = False
    for line, translation, source in results:
        row = current.get(line.segment_id)
        if row is None:
            continue
        row.english_machine = translation.text.strip() or None
        row.english_source_hash = line.fingerprint
        if source is None and row.language is None:
            row.language = _known_language(known, translation.detected_language)
            detected = True
            if row.language == "en":
                row.english_machine = row.english_source_hash = None
    if detected:
        _record_languages(session, interview, _segments(session, interview_id))
    if any(english_is_stale(s) for s in current.values()):
        jobs.enqueue(session, "retranslate", interview_id)
    usable = sum(1 for _, translation, _ in results if translation.text.strip())
    return _Translated(len(segments), len(results), usable)


def translate(
    session: Session,
    interview_id: uuid.UUID,
    providers: Providers,
    store: MediaStore,
    heartbeat: Heartbeat,
) -> None:
    """English for every line not spoken in English. When none of them comes back with
    English, the step fails like any other translation failure (`give_up_translating`): the
    interview is indexed without English and its translation shows as failed."""
    interview = _interview(session, interview_id)
    interview.status_detail = "Translating"
    session.commit()
    outcome = _translate_lines(session, interview_id, providers, heartbeat, only_stale=False)
    if outcome.needed and not outcome.usable:
        raise StepError("The translation service returned no English for any line.")
    if outcome.needed:
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
    if not _translate_lines(session, interview_id, providers, heartbeat, only_stale=True).lines:
        return
    interview.translated_by = providers.translator.name
    jobs.enqueue(session, "index", interview_id)


def give_up_translating(session: Session, interview_id: uuid.UUID, error: str) -> None:
    """English is allowed to fail: index what there is and leave the gap visible."""
    interview = _interview(session, interview_id)
    interview.translation_status = "failed"
    interview.status_detail = f"English translation failed. {error}"
    jobs.enqueue(session, "index", interview_id)


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def _chunk_texts(members: list[SegmentRow], interview: InterviewRow) -> dict[str, str]:
    """The text each representation embeds for one chunk. English speech counts as English;
    "original" is left out when the chunk is all English."""
    english_speech = [_source_language(s, interview) == "en" for s in members]
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


ChunkKey = tuple[int, int, int, int]  # first_seq, last_seq, start_ms, end_ms


def _plan_chunks(
    segments: list[SegmentRow], interview: InterviewRow
) -> list[tuple[ChunkKey, dict[str, str]]]:
    """The search chunks the lines make, each with the texts to embed for it."""
    by_seq = {s.seq: s for s in segments}
    plan = []
    for chunk in chunk_segments([Timed(s.seq, s.start_ms, s.end_ms) for s in segments]):
        members = [by_seq[seq] for seq in range(chunk.first_seq, chunk.last_seq + 1)]
        key = (chunk.first_seq, chunk.last_seq, chunk.start_ms, chunk.end_ms)
        plan.append((key, _chunk_texts(members, interview)))
    return plan


def _stored_hashes(
    session: Session, interview_id: uuid.UUID, model: str
) -> dict[tuple[ChunkKey, str], str]:
    """The source hash of each stored embedding of `model`, by chunk and representation.
    Hashes only: the vectors themselves aren't needed to tell what changed."""
    rows = session.execute(
        select(
            SearchChunkRow.first_seq,
            SearchChunkRow.last_seq,
            SearchChunkRow.start_ms,
            SearchChunkRow.end_ms,
            ChunkEmbeddingRow.representation,
            ChunkEmbeddingRow.source_hash,
        )
        .join(ChunkEmbeddingRow, ChunkEmbeddingRow.chunk_id == SearchChunkRow.id)
        .where(
            SearchChunkRow.interview_id == interview_id,
            SearchChunkRow.chunker == CHUNKER,
            ChunkEmbeddingRow.model == model,
        )
    )
    return {((a, b, c, d), rep): source_hash for a, b, c, d, rep, source_hash in rows}


# Embeddings written per INSERT statement.
_WRITE_BATCH = 500


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

    The plan is made from the lines as read, the embedder runs with no transaction open, and
    the results are written in one short transaction only if the lines still make the same
    plan; otherwise nothing is written and indexing is queued again for the new text.
    """
    interview = _interview(session, interview_id)
    if interview.translation_status != "failed":
        interview.status_detail = "Indexing for search"
    model = providers.embedder.name
    plan = _plan_chunks(_segments(session, interview_id, fresh=True), interview)
    stored = _stored_hashes(session, interview_id, model)
    pending = {
        (key, representation): text
        for key, texts in plan
        for representation, text in texts.items()
        if stored.get((key, representation)) != _sha256(text)
    }
    session.commit()  # no transaction stays open while the embedder runs

    vectors: dict[tuple[ChunkKey, str], list[float]] = {}
    if pending:
        embedded = providers.embedder.embed(list(pending.values()), "passage")
        vectors = dict(zip(pending, embedded, strict=True))
        heartbeat()

    transcripts.lock_interview(session, interview_id)
    session.refresh(interview)
    if _plan_chunks(_segments(session, interview_id, fresh=True), interview) != plan:
        jobs.enqueue(session, "index", interview_id)
        return

    existing = {
        (c.first_seq, c.last_seq, c.start_ms, c.end_ms): c
        for c in session.scalars(
            select(SearchChunkRow).where(
                SearchChunkRow.interview_id == interview_id, SearchChunkRow.chunker == CHUNKER
            )
        )
    }
    rows: dict[ChunkKey, SearchChunkRow] = {}
    for key, _ in plan:
        row = existing.pop(key, None)
        if row is None:
            first_seq, last_seq, start_ms, end_ms = key
            row = SearchChunkRow(
                interview_id=interview_id,
                chunker=CHUNKER,
                first_seq=first_seq,
                last_seq=last_seq,
                start_ms=start_ms,
                end_ms=end_ms,
            )
            session.add(row)
        rows[key] = row
    if existing:  # chunks that no longer match the segments, with all their embeddings
        session.execute(
            delete(SearchChunkRow).where(SearchChunkRow.id.in_(c.id for c in existing.values()))
        )
    session.flush()  # assigns new chunk ids

    wanted = {(key, representation) for key, texts in plan for representation in texts}
    unwanted = [
        (rows[key].id, representation)
        for key, representation in _stored_hashes(session, interview_id, model)
        if (key, representation) not in wanted and key in rows
    ]
    if unwanted:  # e.g. the English text is now empty
        session.execute(
            delete(ChunkEmbeddingRow).where(
                ChunkEmbeddingRow.model == model,
                tuple_(ChunkEmbeddingRow.chunk_id, ChunkEmbeddingRow.representation).in_(unwanted),
            )
        )

    values = [
        {
            "chunk_id": rows[key].id,
            "model": model,
            "representation": representation,
            "embedding": vector,
            "source_hash": _sha256(pending[(key, representation)]),
        }
        for (key, representation), vector in vectors.items()
    ]
    for start in range(0, len(values), _WRITE_BATCH):
        statement = insert(ChunkEmbeddingRow).values(values[start : start + _WRITE_BATCH])
        session.execute(
            statement.on_conflict_do_update(
                index_elements=["chunk_id", "model", "representation"],
                set_={
                    "embedding": statement.excluded.embedding,
                    "source_hash": statement.excluded.source_hash,
                    "created_at": func.now(),
                },
            )
        )

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
    """Make the copy the player streams. Independent of the transcript steps.

    Each run writes a new storage key, so the bytes the current row points at are never
    overwritten. The row moves to the new copy in one commit (which checks the job's claim),
    and the old copy is deleted only after that; if the commit fails, the new copy is.
    """
    interview = _interview(session, interview_id)
    original = _original_media(session, interview_id)
    session.commit()
    with store.local_copy(original.storage_key) as source, tempfile.TemporaryDirectory() as tmp:
        made, content_type = audio.make_playback(source, Path(tmp) / "playback", heartbeat)
        key = f"interviews/{interview_id}/playback-{uuid.uuid4().hex}{made.suffix}"
        size = made.stat().st_size
        digest = file_sha256(made)
        try:
            store.put(key, made)
        except BaseException:
            store.delete(key)
            raise

    try:
        current = session.scalar(
            select(MediaFileRow).where(
                MediaFileRow.interview_id == interview_id, MediaFileRow.kind == "playback"
            )
        )
        old_key = current.storage_key if current is not None else None
        if current is None:
            current = MediaFileRow(interview_id=interview_id, kind="playback")
            session.add(current)
        current.storage_key = key
        current.content_type = content_type
        current.size_bytes = size
        current.sha256 = digest
        if interview.status_detail and interview.status_detail.startswith(PLAYBACK_FAILED):
            interview.status_detail = None  # the failure this replaces
        session.flush()
        session.commit()
    except BaseException as exc:
        # Unless the database may have taken the commit (the connection broke during it),
        # nothing points at the new copy, so it goes.
        committed_maybe = isinstance(exc, DBAPIError) and exc.connection_invalidated
        session.rollback()
        if not committed_maybe:
            store.delete(key)
        raise
    if old_key is not None and old_key != key:
        store.delete(old_key)


def give_up_retranslating(session: Session, interview_id: uuid.UUID, error: str) -> None:
    """The edited lines keep their old English and still show as out of date, so an admin
    can retry with "Update English now"."""
    interview = _interview(session, interview_id)
    interview.status_detail = f"Updating the English after edits failed. {error}"


def give_up_playback(session: Session, interview_id: uuid.UUID, error: str) -> None:
    """The transcript is still usable without a player, so the status stays as it is. A
    transcript failure says more, so it isn't overwritten; the steps table shows both."""
    interview = _interview(session, interview_id)
    if interview.status == "failed":
        return
    interview.status_detail = f"{PLAYBACK_FAILED}. {error}"


def _failed(interview_id: uuid.UUID, session: Session, detail: str) -> None:
    interview = session.get(InterviewRow, interview_id)
    if interview is not None:
        interview.status = "failed"
        interview.status_detail = detail


def give_up_transcribing(session: Session, interview_id: uuid.UUID, error: str) -> None:
    """No transcript: show it to admins as Failed."""
    _failed(interview_id, session, f"Transcription failed. {error}")


def give_up_indexing(session: Session, interview_id: uuid.UUID, error: str) -> None:
    """Record the indexing failure without removing the transcript."""
    _failed(interview_id, session, f"Search indexing failed. {error}")


Step = Callable[[Session, uuid.UUID, Providers, MediaStore, Heartbeat], None]
STEPS: dict[str, Step] = {
    "transcribe": transcribe,
    "translate": translate,
    "index": index,
    "playback": playback,
    "retranslate": retranslate,
    "retranscribe": retranscribe,
}
GIVE_UP: dict[str, Callable[[Session, uuid.UUID, str], None]] = {
    "transcribe": give_up_transcribing,
    "translate": give_up_translating,
    "index": give_up_indexing,
    "playback": give_up_playback,
    "retranslate": give_up_retranslating,
    "retranscribe": give_up_transcribing,
}
