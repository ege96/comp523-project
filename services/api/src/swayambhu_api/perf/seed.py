"""Fill a scratch database with a synthetic archive for performance tests.

    python -m swayambhu_api.perf.seed --scale 1      # 30 one-hour interviews
    python -m swayambhu_api.perf.seed --scale 10     # 300
    python -m swayambhu_api.perf.seed --interviews 3 --minutes 5   # tiny

It writes interviews, lines, search chunks and embeddings straight into Postgres with COPY,
without the worker, so even the 30x archive is ready in minutes. Every run with the same
arguments writes the same data (fixed random seed).

The data is placeholder text from fixed and made-up word lists, not archive content: two
thirds of the interviews are "Nepali" (Devanagari placeholder words with English placeholder
translations), the rest English. Half are Public, so visibility filtering is part of every
search. Lines are 2 s long and grouped by the worker's own chunker. Embeddings are random unit
vectors named after the configured embedder (`EMBEDDING_PROVIDER=fake
EMBEDDING_DIMENSIONS=384` matches e5-small's size), so the API's semantic search compares
against them.

It deletes every interview first, so it only runs against a database whose name ends in
`_perf` or `_test`.
"""

import argparse
import math
import random
import time
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date

import psycopg
from sqlalchemy import Engine
from sqlalchemy.engine import make_url
from swayambhu_core.chunking import Timed, chunk_segments
from swayambhu_core.models import CHUNKER
from swayambhu_providers.factory import embedder_name

from swayambhu_api.config import Settings
from swayambhu_api.db import get_engine

LINE_MS = 2_000
INTERVIEWS_PER_SCALE = 30
SEED = 523


def _words(text: str) -> list[str]:
    return text.split()


# Placeholder vocabulary. perf/queries.txt draws its words from these lists.
ENGLISH = _words(
    """
    stupa steps morning lamp butter monkey pigeon prayer wheel flag festival temple bell
    incense monastery hill rice tea shop market grandmother father mother children
    village valley river earthquake repair gold painting eyes dome courtyard pilgrim
    song drum evening night winter monsoon rain road walk climb offering worship ritual
    story memory school family neighbour visitor tourist photograph candle stone statue
    shrine
    """
)
FILLER = _words(
    """
    we they the a to in of and was were used every there then after when our
    """
)
# How often a word is one of the named words above (the rest are made-up words from a pool of
# a few thousand), so each named word is in about 1% of lines: commoner than most real
# content words, which keeps keyword search on the slow side.
NAMED_RATE = 0.1
DEVANAGARI = _words(
    """
    स्तूप सिँढी बिहान बत्ती घ्यू बाँदर परेवा माने झण्डा चाड मन्दिर घण्टा धूप गुम्बा
    डाँडा चामल चिया पसल बजार हजुरआमा बुबा आमा केटाकेटी गाउँ उपत्यका खोला भूकम्प मर्मत
    सुन चित्र आँखा आँगन तीर्थयात्री गीत दमाहा साँझ रात जाडो बर्खा पानी बाटो पूजा भेटी
    कथा सम्झना विद्यालय परिवार छिमेकी पाहुना पर्यटक तस्बिर मैनबत्ती ढुङ्गा मूर्ति
    """
)
DEVANAGARI_FILLER = _words(
    """
    हामी उनीहरू त्यो यो र मा को पनि थियो थिए हुन्थ्यो पछि जब
    """
)


@dataclass(frozen=True)
class Counts:
    interviews: int
    lines: int
    chunks: int
    embeddings: int


def _pool(syllables: list[str], size: int) -> list[str]:
    rng = random.Random(SEED)  # noqa: S311 (test data, not secrets)
    return sorted({"".join(rng.choices(syllables, k=rng.randint(2, 4))) for _ in range(size)})


ENGLISH_POOL = _pool([c + v for c in "bdgklmnprst" for v in "aeiou"], 4000)
DEVANAGARI_POOL = _pool(
    [c + v for c in "कखगचजटडतदनपबमरलसह" for v in ("", "ा", "ि", "ी", "ु", "े", "ो")], 4000
)


def _sentence(rng: random.Random, named: list[str], pool: list[str], filler: list[str]) -> str:
    words = []
    for _ in range(rng.randint(6, 12)):
        roll = rng.random()
        source = named if roll < NAMED_RATE else filler if roll < 0.5 else pool
        words.append(rng.choice(source))
    return " ".join(words)


def _vector(rng: random.Random, dimensions: int) -> str:
    raw = [rng.gauss(0.0, 1.0) for _ in range(dimensions)]
    norm = math.sqrt(sum(x * x for x in raw)) or 1.0
    return "[" + ",".join(f"{x / norm:.5f}" for x in raw) + "]"


def check_database(database_url: str) -> None:
    name = make_url(database_url).database or ""
    if not name.endswith(("_perf", "_test")):
        raise SystemExit(
            f"Refusing to seed {name!r}: it deletes every interview. Use a *_perf database."
        )


def seed(engine: Engine, interviews: int, minutes: int, model: str, dimensions: int) -> Counts:
    rng = random.Random(SEED)  # noqa: S311 (test data, not secrets)
    lines_per = minutes * 60_000 // LINE_MS
    raw = engine.raw_connection()
    try:
        conn = raw.driver_connection
        if not isinstance(conn, psycopg.Connection):
            raise TypeError("expected a psycopg 3 connection")
        with conn.cursor() as cur:
            cur.execute("DELETE FROM interviews")
            cur.execute("DELETE FROM interviewees")
            cur.execute(
                "INSERT INTO interviewees (display_name) SELECT 'Placeholder interviewee ' || n "
                "FROM generate_series(1, 20) n RETURNING id"
            )
            people = [row[0] for row in cur.fetchall()]

            meta: list[tuple[object, ...]] = []
            segments: list[tuple[object, ...]] = []
            chunks: list[tuple[uuid.UUID, int, int, int, int, bool]] = []
            for i in range(interviews):
                interview_id = uuid.UUID(int=rng.getrandbits(128), version=4)
                nepali = i % 3 != 2
                language = "ne" if nepali else "en"
                recorded = date(rng.randint(1990, 2024), 1, 1) if i % 4 else None
                meta.append((
                    interview_id, f"Perf interview {i + 1:04d}",
                    "public" if i % 2 == 0 else "private", "done",
                    "done" if nepali else "not_needed", language,
                    rng.choice(people) if i % 5 else None, recorded,
                    "year" if recorded else None, lines_per * LINE_MS,
                ))  # fmt: skip
                timed = []
                for seq in range(lines_per):
                    start = seq * LINE_MS
                    if nepali:
                        original = _sentence(rng, DEVANAGARI, DEVANAGARI_POOL, DEVANAGARI_FILLER)
                        english: str | None = _sentence(rng, ENGLISH, ENGLISH_POOL, FILLER)
                    else:
                        original, english = _sentence(rng, ENGLISH, ENGLISH_POOL, FILLER), None
                    segments.append(
                        (interview_id, seq, start, start + LINE_MS, language, original, english)
                    )
                    timed.append(Timed(seq, start, start + LINE_MS))
                chunks.extend(
                    (interview_id, c.first_seq, c.last_seq, c.start_ms, c.end_ms, nepali)
                    for c in chunk_segments(timed)
                )

            _copy(cur, "interviews (id, title, visibility, status, translation_status, "
                  "language_confirmed, interviewee_id, recorded_on, recorded_on_precision, "
                  "duration_ms)", meta)  # fmt: skip
            _copy(cur, "interview_languages (interview_id, language_code)",
                  [(m[0], m[5]) for m in meta])  # fmt: skip
            _copy(cur, "segments (interview_id, seq, start_ms, end_ms, language, "
                  "original_machine, english_machine)", segments)  # fmt: skip
            _copy(cur, "search_chunks (interview_id, chunker, first_seq, last_seq, start_ms, "
                  "end_ms)", [(c[0], CHUNKER, *c[1:5]) for c in chunks])  # fmt: skip
            cur.execute(
                "SELECT id, interview_id, first_seq FROM search_chunks WHERE chunker = %s",
                (CHUNKER,),
            )
            chunk_ids = {(i, first): cid for cid, i, first in cur.fetchall()}
            # Like the worker: an English and an original vector for Nepali, English only else.
            embeddings = [
                (chunk_ids[(c[0], c[1])], model, rep, _vector(rng, dimensions), "perf")
                for c in chunks
                for rep in (("english", "original") if c[5] else ("english",))
            ]
            _copy(cur, "chunk_embeddings (chunk_id, model, representation, embedding, "
                  "source_hash)", embeddings)  # fmt: skip
            cur.execute("ANALYZE")
        conn.commit()
    finally:
        raw.close()
    return Counts(len(meta), len(segments), len(chunks), len(embeddings))


def _copy(
    cur: psycopg.Cursor[tuple[object, ...]], target: str, rows: Sequence[tuple[object, ...]]
) -> None:
    with cur.copy(f"COPY {target} FROM STDIN") as copy:  # target is a constant from this module
        for row in rows:
            copy.write_row(row)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    size = parser.add_mutually_exclusive_group()
    size.add_argument("--scale", type=int, default=1, help="1x = 30 interviews (default 1)")
    size.add_argument("--interviews", type=int, help="exact number of interviews")
    parser.add_argument("--minutes", type=int, default=60, help="length of each (default 60)")
    args = parser.parse_args(argv)
    settings = Settings()
    check_database(settings.database_url)
    interviews = args.interviews or args.scale * INTERVIEWS_PER_SCALE
    # The vector size the configured embedder produces; fake defaults to 8, so set 384.
    dimensions = settings.embedding_dimensions or 384
    began = time.monotonic()
    counts = seed(
        get_engine(settings), interviews, args.minutes, embedder_name(settings), dimensions
    )
    print(
        f"Seeded {counts.interviews} interviews, {counts.lines} lines, {counts.chunks} chunks "
        f"and {counts.embeddings} {dimensions}-dim embeddings in {time.monotonic() - began:.0f} s"
    )


if __name__ == "__main__":
    main()
