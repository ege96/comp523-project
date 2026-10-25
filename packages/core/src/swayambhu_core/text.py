"""Deciding when a line's English no longer matches its original text."""

import hashlib
import unicodedata

from swayambhu_core.models import SegmentRow


def translation_fingerprint(text: str) -> str:
    """A hash of the words alone: case, spacing and punctuation (the Devanagari danda
    included) don't change it, so tidying those doesn't trigger a new translation."""
    normalized = unicodedata.normalize("NFC", text).casefold()
    words = "".join(" " if unicodedata.category(c)[0] in "PZC" else c for c in normalized)
    return hashlib.sha256(" ".join(words.split()).encode()).hexdigest()


def _original(segment: SegmentRow) -> str:
    # Not `original_text`: that generated column is only refreshed after a flush and reload.
    if segment.original_edited is not None:
        return segment.original_edited
    return segment.original_machine


def english_is_stale(segment: SegmentRow) -> bool:
    """Whether the original's words changed since the machine English was made.

    `english_source_hash` is the fingerprint of the text the machine English was made from.
    Lines translated before it existed have none; those were made from the machine original.
    Lines without machine English (English speech, failed translation) are never stale.
    """
    if segment.english_machine is None:
        return False
    source = segment.english_source_hash or translation_fingerprint(segment.original_machine)
    return source != translation_fingerprint(_original(segment))


def english_edit_is_stale(segment: SegmentRow) -> bool:
    """Whether the original's words changed since an admin last saved the English edit, so
    the edit needs checking. Re-translation never touches it."""
    if segment.english_edited is None:
        return False
    # Edits saved before the hash existed are taken as made against the machine original.
    source = segment.english_edit_source_hash or translation_fingerprint(segment.original_machine)
    return source != translation_fingerprint(_original(segment))
