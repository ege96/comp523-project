"""Add a recording from the command line and queue it for processing.

Does what the upload route (`POST /api/interviews`) does, for bulk loads and testing. Run it
where the worker runs, so the file lands in the worker's media directory:

    python -m swayambhu_worker.ingest interview.mp3 --title "Interview with ..." --language ne
"""

import argparse
import mimetypes
import uuid
from pathlib import Path

from sqlalchemy.orm import Session
from swayambhu_core.models import InterviewRow
from swayambhu_core.recordings import add_original, original_key
from swayambhu_core.storage import LocalMediaStore, MediaStore, file_sha256

from swayambhu_worker.config import WorkerSettings
from swayambhu_worker.db import session_factory


def ingest(
    session: Session, store: MediaStore, path: Path, title: str, language: str | None
) -> uuid.UUID:
    """Store the file, create a Private interview for it, and queue its processing."""
    interview = InterviewRow(title=title, language_confirmed=language)
    session.add(interview)
    session.flush()
    key = original_key(interview.id, path.suffix)
    store.put(key, path)
    add_original(
        session,
        interview.id,
        key=key,
        content_type=mimetypes.guess_type(path.name)[0] or "application/octet-stream",
        size_bytes=path.stat().st_size,
        sha256=file_sha256(path),
    )
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
