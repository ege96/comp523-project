from swayambhu_core.models import SegmentRow
from swayambhu_core.text import english_edit_is_stale, english_is_stale, translation_fingerprint


def test_fingerprint_ignores_case_spacing_and_punctuation() -> None:
    assert translation_fingerprint("स्वयम्भू, बिहान।") == translation_fingerprint("स्वयम्भू  बिहान ।")
    assert translation_fingerprint("The Stupa!") == translation_fingerprint("the stupa")
    assert translation_fingerprint("स्वयम्भू बिहान") != translation_fingerprint("स्वयम्भू साँझ")


def line(**values: object) -> SegmentRow:
    return SegmentRow(original_machine="पहिलो कुरा", english_machine="First thing", **values)


def test_english_is_stale_only_when_the_originals_words_changed() -> None:
    assert not english_is_stale(line())  # made before the hash existed: from the machine text
    assert not english_is_stale(line(original_edited="पहिलो, कुरा।"))
    assert english_is_stale(line(original_edited="दोस्रो कुरा"))
    made_from_edit = translation_fingerprint("दोस्रो कुरा")
    assert not english_is_stale(
        line(original_edited="दोस्रो कुरा", english_source_hash=made_from_edit)
    )
    assert not english_is_stale(SegmentRow(original_machine="x", original_edited="y"))


def test_an_english_edit_needs_checking_once_the_original_changes_after_it() -> None:
    edited = line(english_edited="The first thing")
    assert not english_edit_is_stale(edited)
    edited.original_edited = "दोस्रो कुरा"
    assert english_edit_is_stale(edited)
    # Re-translation refreshes the machine English, but the human edit still needs a look.
    edited.english_source_hash = translation_fingerprint("दोस्रो कुरा")
    assert not english_is_stale(edited) and english_edit_is_stale(edited)
    edited.english_edit_source_hash = translation_fingerprint("दोस्रो कुरा")  # admin saved it
    assert not english_edit_is_stale(edited)
