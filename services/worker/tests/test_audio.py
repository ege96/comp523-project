from pathlib import Path

import pytest
from audio_helpers import SPEECH_AND_PAUSES, make_audio

from swayambhu_worker import audio
from swayambhu_worker.audio import AudioError, Span, plan_pieces


def test_finds_the_pauses_and_cuts_inside_them(tmp_path: Path) -> None:
    source = make_audio(tmp_path / "talk.wav", SPEECH_AND_PAUSES, 40)
    assert audio.duration_ms(source) == 40_000

    pauses = audio.silences(source)
    assert [(round(p.start_ms, -2), round(p.end_ms, -2)) for p in pauses][:3] == [
        (8000, 10000),
        (18000, 20000),
        (28000, 30000),
    ]
    pieces = plan_pieces(40_000, pauses)
    assert pieces[0].start_ms == 0
    assert pieces[-1].end_ms == 40_000
    for piece in pieces[:-1]:
        assert any(p.start_ms <= piece.end_ms <= p.end_ms for p in pauses)

    clip = tmp_path / "piece.flac"
    audio.cut(source, pieces[0], clip)
    assert abs(audio.duration_ms(clip) - (pieces[0].end_ms - pieces[0].start_ms)) < 50


def test_plan_prefers_the_longest_pause_in_the_window() -> None:
    pauses = [Span(6_000, 6_400), Span(12_000, 13_000), Span(17_000, 17_300)]
    assert plan_pieces(30_000, pauses)[0] == Span(0, 12_500)


def test_plan_cuts_at_the_maximum_when_nobody_pauses() -> None:
    assert plan_pieces(45_000, []) == [Span(0, 20_000), Span(20_000, 40_000), Span(40_000, 45_000)]


def test_plan_ignores_pauses_too_early_to_cut() -> None:
    assert plan_pieces(25_000, [Span(1_000, 2_000)]) == [Span(0, 20_000), Span(20_000, 25_000)]


def test_short_recordings_are_one_piece() -> None:
    assert plan_pieces(3_000, []) == [Span(0, 3_000)]
    assert plan_pieces(0, []) == []


def test_unreadable_audio_is_an_audio_error(tmp_path: Path) -> None:
    junk = tmp_path / "junk.mp3"
    junk.write_bytes(b"not audio")
    with pytest.raises(AudioError):
        audio.duration_ms(junk)
