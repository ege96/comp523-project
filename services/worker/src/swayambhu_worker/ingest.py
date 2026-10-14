"""Add a recording from the command line and queue it for processing.

Stands in for the admin upload page until it exists. Run it where the worker runs, so the
file lands in the worker's media directory:

    python -m swayambhu_worker.ingest interview.mp3 --title "Interview with ..." --language ne
"""

import argparse
import hashlib
import mimetypes
import uuid
from pathlib import Path

from sqlalchemy.orm import Session
from swayambhu_core import jobs
from swayambhu_core.models import InterviewRow, MediaFileRow
from swayambhu_core.storage import LocalMediaStore, MediaStore

from swayambhu_worker.config import WorkerSettings
from swayambhu_worker.db import session_factory


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def ingest(
    session: Session, store: MediaStore, path: Path, title: str, language: str | None
) -> uuid.UUID:
    """Store the file, create a Private interview for it, and queue transcription."""
    interview = InterviewRow(title=title, language_confirmed=language)
    session.add(interview)
    session.flush()
    key = f"interviews/{interview.id}/original{path.suffix.lower()}"
    store.put(key, path)
    session.add(
        MediaFileRow(
            interview_id=interview.id,
            kind="original",
            storage_key=key,
            content_type=mimetypes.guess_type(path.name)[0] or "application/octet-stream",
            size_bytes=path.stat().st_size,
            sha256=_sha256(path),
        )
    )
    jobs.enqueue(session, "transcribe", interview.id)
    return interview.id


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("file", type=Path, help="audio or video file")
    parser.add_argument("--title", required=True)
    parser.add_argument(
        "--language",
        help="language code if known (en, ne, new); otherwise it is detected",
    )
    args = parser.parse_args(argv)
    if not args.file.is_file():
        parser.error(f"{args.file} is not a file")

    settings = WorkerSettings()
    with session_factory(settings)() as session:
        interview_id = ingest(
            session, LocalMediaStore(settings.media_root), args.file, args.title, args.language
        )
        session.commit()
    print(f"Queued interview {interview_id}")


if __name__ == "__main__":
    main()
