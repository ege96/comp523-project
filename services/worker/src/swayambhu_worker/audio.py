"""Cutting a recording into short pieces at its quietest moments, with FFmpeg (P-014, D-013).

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
# Loudness is measured per frame; a cut goes in the middle of the quietest few frames.
FRAME_MS = 100
QUIET_FRAMES = 3
SILENT_DB = -120.0  # stands in for -inf (digital silence)


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
