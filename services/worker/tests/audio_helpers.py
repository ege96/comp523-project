import subprocess
from pathlib import Path

# 8 s of tone, then 2 s of silence, repeated.
SPEECH_AND_PAUSES = "if(lt(mod(t,10),8),0.5*sin(2*PI*440*t),0)"


def make_audio(path: Path, expression: str, seconds: float) -> Path:
    """Synthetic audio: `expression` is an FFmpeg aevalsrc formula of t (seconds)."""
    subprocess.run(  # noqa: S603
        [  # noqa: S607
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
            "-i", f"aevalsrc='{expression}':d={seconds}:s=16000", str(path),
        ],
        check=True,
    )  # fmt: skip
    return path
