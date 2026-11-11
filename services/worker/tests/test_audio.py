import subprocess
import time
from pathlib import Path

import pytest
from audio_helpers import SPEECH_AND_PAUSES, make_audio

from swayambhu_worker import audio
from swayambhu_worker.audio import AudioError, Span, plan_pieces

# Loud speech over constant background noise (never silent), dipping at 12 s and 27 s.
SPEECH_OVER_NOISE = (
    "0.05*sin(2*PI*90*t)+if(lt(abs(t-12),0.25)+lt(abs(t-27),0.25),0,0.5*sin(2*PI*440*t))"
)


def test_cuts_inside_pauses(tmp_path: Path) -> None:
    source = make_audio(tmp_path / "talk.wav", SPEECH_AND_PAUSES, 40)
    assert audio.duration_ms(source) == 40_000

    levels = audio.loudness(source)
    assert len(levels) == 400
    pieces = plan_pieces(40_000, levels)
    assert (pieces[0].start_ms, pieces[-1].end_ms) == (0, 40_000)
    # Tone for 8 s, silence for 2 s: every cut lands in a silent stretch.
    assert all(piece.end_ms % 10_000 >= 8_000 for piece in pieces[:-1])

    clip = tmp_path / "piece.flac"
    audio.cut(source, pieces[0], clip)
    assert abs(audio.duration_ms(clip) - (pieces[0].end_ms - pieces[0].start_ms)) < 50


def test_cuts_at_dips_when_background_noise_never_stops(tmp_path: Path) -> None:
    source = make_audio(tmp_path / "noisy.wav", SPEECH_OVER_NOISE, 35)
    assert min(audio.loudness(source)) > audio.SILENT_DB  # never silent
    pieces = plan_pieces(35_000, audio.loudness(source))
    cuts = [piece.end_ms for piece in pieces[:-1]]
    assert len(cuts) == 2
    assert abs(cuts[0] - 12_000) <= 200
    assert abs(cuts[1] - 27_000) <= 200


def quiet_at(*frames: int, length: int = 300) -> list[float]:
    return [-60.0 if i in frames else -20.0 for i in range(length)]


def test_plan_picks_the_quietest_moment_in_the_window() -> None:
    assert plan_pieces(30_000, quiet_at(70, 125, 180))[0] == Span(0, 18_050)
    levels = quiet_at(70, 125, 180)
    levels[125] = -90.0
    assert plan_pieces(30_000, levels)[0] == Span(0, 12_550)


def test_plan_ignores_quiet_moments_too_early_to_cut() -> None:
    pieces = plan_pieces(25_000, quiet_at(10, length=250))
    assert pieces[0].end_ms >= 5_000


def test_plan_cuts_at_the_maximum_without_loudness() -> None:
    assert plan_pieces(45_000, []) == [Span(0, 20_000), Span(20_000, 40_000), Span(40_000, 45_000)]


def test_short_recordings_are_one_piece() -> None:
    assert plan_pieces(3_000, []) == [Span(0, 3_000)]
    assert plan_pieces(0, []) == []


def test_playback_copy_of_audio_is_m4a(tmp_path: Path) -> None:
    source = make_audio(tmp_path / "talk.wav", SPEECH_AND_PAUSES, 3)
    made, content_type = audio.make_playback(source, tmp_path / "playback")
    assert (made.name, content_type) == ("playback.m4a", "audio/mp4")
    assert not audio.has_video(made)
    assert abs(audio.duration_ms(made) - 3_000) < 100


def test_playback_copy_of_video_is_mp4_at_most_720p(tmp_path: Path) -> None:
    source = tmp_path / "clip.mkv"
    subprocess.run(  # noqa: S603
        [  # noqa: S607
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "testsrc=size=1920x1080:rate=10:duration=2",
            "-f", "lavfi", "-i", "sine=duration=2", "-shortest", str(source),
        ],
        check=True,
    )  # fmt: skip
    seen: list[int] = []
    made, content_type = audio.make_playback(source, tmp_path / "playback", lambda: seen.append(1))
    assert (made.name, content_type) == ("playback.mp4", "video/mp4")
    probe = subprocess.run(  # noqa: S603
        ["ffprobe", "-v", "error", "-select_streams", "v", "-show_entries",  # noqa: S607
         "stream=height", "-of", "csv=p=0", str(made)],
        capture_output=True, text=True, check=True,
    )  # fmt: skip
    assert probe.stdout.strip() == "720"


def test_audio_with_cover_art_gets_an_audio_playback_copy(tmp_path: Path) -> None:
    tone = make_audio(tmp_path / "tone.wav", SPEECH_AND_PAUSES, 3)
    cover = tmp_path / "cover.jpg"
    source = tmp_path / "song.m4a"
    ffmpeg = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
    subprocess.run(  # noqa: S603
        [*ffmpeg, "-f", "lavfi", "-i", "color=red:size=64x64", "-frames:v", "1", str(cover)],
        check=True,
    )
    subprocess.run(  # noqa: S603
        [
            *ffmpeg, "-i", str(tone), "-i", str(cover), "-map", "0:a", "-map", "1:v",
            "-c:a", "aac", "-c:v", "mjpeg", "-disposition:v:0", "attached_pic", str(source),
        ],
        check=True,
    )  # fmt: skip
    assert not audio.has_video(source)
    made, content_type = audio.make_playback(source, tmp_path / "playback")
    assert (made.name, content_type) == ("playback.m4a", "audio/mp4")


def test_a_slow_media_command_keeps_the_lease_then_stops_at_the_deadline(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(audio, "HEARTBEAT_SECONDS", 0.1)
    beats: list[float] = []
    began = time.monotonic()
    with audio.supervised(lambda: beats.append(1), 0.5), pytest.raises(audio.MediaTimeoutError):
        audio._run(["sleep", "30"])
    assert time.monotonic() - began < 5
    assert len(beats) >= 2


def test_unreadable_audio_is_an_audio_error(tmp_path: Path) -> None:
    junk = tmp_path / "junk.mp3"
    junk.write_bytes(b"not audio")
    with pytest.raises(AudioError):
        audio.duration_ms(junk)
    with pytest.raises(AudioError):
        audio.loudness(junk)
