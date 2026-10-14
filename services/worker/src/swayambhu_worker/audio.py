"""Cutting a recording into short pieces at pauses, with FFmpeg (P-014, D-013).

Each piece is transcribed on its own, so segment timestamps come from the cut points and
don't depend on whether a provider returns timestamps. Thresholds are first guesses, to be
tuned on the sample Nepali audio.
"""

import json
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

MIN_PIECE_MS = 5_000
MAX_PIECE_MS = 20_000
# Quieter than this for at least this long counts as a pause.
SILENCE_NOISE_DB = -30
SILENCE_MIN_SECONDS = 0.3


class AudioError(Exception):
    """FFmpeg couldn't read the file: not audio, or corrupt. Retrying won't help."""


@dataclass(frozen=True)
class Span:
    start_ms: int
    end_ms: int


def _run(args: list[str]) -> str:
    result = subprocess.run(args, capture_output=True, text=True, check=False)  # noqa: S603
    if result.returncode != 0:
        raise AudioError(f"{args[0]} failed: {result.stderr.strip()[-500:]}")
    return result.stdout + result.stderr


def duration_ms(path: Path) -> int:
    out = _run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)]
    )
    try:
        return round(float(json.loads(out)["format"]["duration"]) * 1000)
    except (KeyError, ValueError) as exc:
        raise AudioError(f"No duration in {path.name}") from exc


_SILENCE = re.compile(r"silence_(start|end): (-?[\d.]+)")


def silences(path: Path) -> list[Span]:
    """Pauses in the recording, from FFmpeg's silencedetect filter."""
    out = _run(
        [
            "ffmpeg", "-hide_banner", "-nostats", "-i", str(path), "-vn",
            "-af", f"silencedetect=noise={SILENCE_NOISE_DB}dB:d={SILENCE_MIN_SECONDS}",
            "-f", "null", "-",
        ]
    )  # fmt: skip
    found: list[Span] = []
    start: int | None = None
    for kind, seconds in _SILENCE.findall(out):
        ms = max(0, round(float(seconds) * 1000))
        if kind == "start":
            start = ms
        elif start is not None:
            found.append(Span(start, ms))
            start = None
    return found


def plan_pieces(
    total_ms: int,
    pauses: list[Span],
    min_ms: int = MIN_PIECE_MS,
    max_ms: int = MAX_PIECE_MS,
) -> list[Span]:
    """Split [0, total_ms) into pieces of at most `max_ms`, cutting in the middle of pauses.

    Within each window the longest pause wins (the likeliest sentence break). Where there
    is no pause, the piece is cut at `max_ms`, mid-speech.
    """
    pieces: list[Span] = []
    start = 0
    while start < total_ms:
        if total_ms - start <= max_ms:
            end = total_ms
        else:
            window = [
                p
                for p in pauses
                if start + min_ms <= (p.start_ms + p.end_ms) // 2 <= start + max_ms
            ]
            if window:
                best = max(window, key=lambda p: (p.end_ms - p.start_ms, p.start_ms))
                end = (best.start_ms + best.end_ms) // 2
            else:
                end = start + max_ms
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
