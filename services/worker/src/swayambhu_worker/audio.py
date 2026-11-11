"""Cutting a recording into short pieces at its quietest moments, with FFmpeg.

Each piece is transcribed on its own, so segment timestamps come from the cut points and
don't depend on whether a provider returns timestamps. Thresholds are first guesses, to be
tuned on the sample Nepali audio.
"""

import json
import re
import subprocess
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from pathlib import Path

MIN_PIECE_MS = 5_000
MAX_PIECE_MS = 20_000
# Loudness is measured per frame; a cut goes in the middle of the quietest few frames.
FRAME_MS = 100
QUIET_FRAMES = 3
SILENT_DB = -120.0  # stands in for -inf (digital silence)
# How often a running FFmpeg or FFprobe renews the job's lease.
HEARTBEAT_SECONDS = 60.0
# The longest one FFmpeg or FFprobe run may take, unless `supervised` sets another limit.
DEFAULT_TIMEOUT_SECONDS = 4 * 3600.0


class AudioError(Exception):
    """FFmpeg couldn't read the file: not audio, or corrupt. Retrying won't help."""


class MediaTimeoutError(Exception):
    """FFmpeg or FFprobe ran past its time limit and was stopped."""


@dataclass(frozen=True)
class Span:
    start_ms: int
    end_ms: int


@dataclass(frozen=True)
class _Liveness:
    heartbeat: Callable[[], None]
    timeout_seconds: float


_liveness: ContextVar[_Liveness | None] = ContextVar("audio_liveness", default=None)


@contextmanager
def supervised(heartbeat: Callable[[], None], timeout_seconds: float) -> Iterator[None]:
    """Within this block every FFmpeg and FFprobe run calls `heartbeat` periodically and is
    stopped after `timeout_seconds`. The runner wraps each job in it."""
    token = _liveness.set(_Liveness(heartbeat, timeout_seconds))
    try:
        yield
    finally:
        _liveness.reset(token)


def _run(args: list[str], heartbeat: Callable[[], None] | None = None) -> str:
    """Run FFmpeg or FFprobe. Long runs call `heartbeat` (or the one from `supervised`) every
    HEARTBEAT_SECONDS so the job keeps its lease, and are killed at the time limit. The
    process is also killed if the heartbeat raises, say because the job was taken over."""
    live = _liveness.get()
    beat = heartbeat or (live.heartbeat if live else None)
    limit = live.timeout_seconds if live else DEFAULT_TIMEOUT_SECONDS
    deadline = time.monotonic() + limit
    with subprocess.Popen(  # noqa: S603
        args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
    ) as proc:
        try:
            while True:
                left = deadline - time.monotonic()
                if left <= 0:
                    raise MediaTimeoutError(f"{args[0]} ran longer than {limit:.0f} s")
                try:
                    stdout, stderr = proc.communicate(timeout=min(HEARTBEAT_SECONDS, left))
                    break
                except subprocess.TimeoutExpired:
                    if beat:
                        beat()
        except BaseException:
            proc.kill()
            raise
    if proc.returncode != 0:
        raise AudioError(f"{args[0]} failed: {stderr.strip()[-500:]}")
    return stdout + stderr


def duration_ms(path: Path) -> int:
    out = _run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)]
    )
    try:
        return round(float(json.loads(out)["format"]["duration"]) * 1000)
    except (KeyError, ValueError) as exc:
        raise AudioError(f"No duration in {path.name}") from exc


_LEVEL = re.compile(r"RMS_level=(\S+)")


def loudness(path: Path) -> list[float]:
    """Loudness in dB for each FRAME_MS of the recording, from FFmpeg's astats filter.

    Used instead of a silence threshold: recordings with background noise or music never
    go silent, but speech still dips between sentences.
    """
    samples = 16_000 * FRAME_MS // 1000
    out = _run(
        [
            "ffmpeg", "-hide_banner", "-nostats", "-loglevel", "error", "-i", str(path), "-vn",
            "-af",
            f"aresample=16000,asetnsamples=n={samples}:p=0,"
            "astats=metadata=1:reset=1:measure_overall=RMS_level:measure_perchannel=none,"
            "ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=-",
            "-f", "null", "-",
        ]
    )  # fmt: skip
    levels = []
    for value in _LEVEL.findall(out):
        try:
            levels.append(max(SILENT_DB, float(value)))
        except ValueError:  # "-inf" parses, but anything else odd counts as silence
            levels.append(SILENT_DB)
    return levels


def _quietest_cut(levels: list[float], earliest_ms: int, latest_ms: int) -> int | None:
    """The middle of the quietest QUIET_FRAMES run whose centre is in the window."""
    first = max(earliest_ms // FRAME_MS, QUIET_FRAMES // 2)
    last = min(latest_ms // FRAME_MS, len(levels) - 1 - QUIET_FRAMES // 2)
    best: tuple[float, float, int] | None = None
    for centre in range(first, last + 1):
        run = levels[centre - QUIET_FRAMES // 2 : centre + QUIET_FRAMES // 2 + 1]
        # Quietest run first, then the quietest centre frame; ties go later (longer pieces).
        score = (sum(run) / len(run), levels[centre], -centre)
        if best is None or score < best:
            best = score
    return None if best is None else -best[2] * FRAME_MS + FRAME_MS // 2


def plan_pieces(
    total_ms: int,
    levels: list[float],
    min_ms: int = MIN_PIECE_MS,
    max_ms: int = MAX_PIECE_MS,
) -> list[Span]:
    """Split [0, total_ms) into pieces of `min_ms` to `max_ms`, each cut at the quietest
    moment in that range: a pause if there is one, otherwise the likeliest breath.
    `levels` is `loudness()`; without it, pieces are cut at `max_ms`.
    """
    pieces: list[Span] = []
    start = 0
    while start < total_ms:
        if total_ms - start <= max_ms:
            end = total_ms
        else:
            cut_ms = _quietest_cut(levels, start + min_ms, start + max_ms)
            end = cut_ms if cut_ms is not None and cut_ms > start else start + max_ms
        pieces.append(Span(start, end))
        start = end
    return pieces


def cut(source: Path, piece: Span, target: Path) -> None:
    """Write one piece as 16 kHz mono FLAC: small, lossless, accepted by the providers."""
    start = f"{piece.start_ms / 1000:.3f}"
    length = f"{(piece.end_ms - piece.start_ms) / 1000:.3f}"
    _run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", start, "-t", length,
            "-i", str(source), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "flac", str(target),
        ]
    )  # fmt: skip


def _motion_video_stream(path: Path) -> int | None:
    """The index of the first motion video stream, if any. Cover art in an MP3 or M4A is a
    one-frame video stream marked as an attached picture, and doesn't count."""
    out = _run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v", "-show_entries",
            "stream=index,codec_type:stream_disposition=attached_pic", "-of", "json", str(path),
        ]
    )  # fmt: skip
    for stream in json.loads(out).get("streams", []):
        if not stream.get("disposition", {}).get("attached_pic"):
            return int(stream["index"])
    return None


def has_video(path: Path) -> bool:
    return _motion_video_stream(path) is not None


def make_playback(
    source: Path, target_stem: Path, heartbeat: Callable[[], None] | None = None
) -> tuple[Path, str]:
    """A copy every browser plays and can seek in while streaming: H.264/AAC MP4 at
    up to 720p for video, AAC M4A for audio. `+faststart` puts the index first, so playback
    starts before the whole file arrives. Returns the file and its content type."""
    common = ["-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-map_metadata", "-1"]
    video_stream = _motion_video_stream(source)
    if video_stream is not None:
        target = target_stem.with_suffix(".mp4")
        video = [
            "-map", f"0:{video_stream}", "-map", "0:a:0?", "-c:v", "libx264",
            "-preset", "veryfast", "-crf", "26",
            "-vf", "scale=-2:'min(720,ih)'", "-pix_fmt", "yuv420p",
        ]  # fmt: skip
        content_type = "video/mp4"
    else:
        target = target_stem.with_suffix(".m4a")
        video = ["-map", "0:a:0", "-vn"]
        content_type = "audio/mp4"
    _run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(source),
         *video, *common, str(target)],
        heartbeat,
    )  # fmt: skip
    return target, content_type
