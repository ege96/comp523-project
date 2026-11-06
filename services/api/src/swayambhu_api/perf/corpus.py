"""Build a real-text search corpus, embedded with the local model, for the performance tests.

    uv run --group perf python -m swayambhu_api.perf.corpus \\
        --fleurs data/fleurs --wiki-ne data/wiki/ne.parquet --wiki-en data/wiki/en0.parquet \\
        --vectors 150000 --out data/corpus

The synthetic archive (`swayambhu_api.perf.seed --scale N`) has made-up words and random
vectors, which say nothing about how an approximate vector index behaves on real embeddings.
This writes passages of real Nepali and English text and their vectors, which
`perf.seed --corpus` then loads into the archive schema.

Sources (download them first, see perf/README.md):
- FLEURS transcripts (CC BY 4.0): the same ~2,000 FLORES sentences read in Nepali (`ne_np`)
  and English (`en_us`), joined by sentence id. Six consecutive sentences make one passage.
  Half the groups become "Nepali interviews" (a Nepali original vector and an English vector
  from the human translation, like the worker's two), half "English interviews" (English
  vector only). These are the labelled part: each sentence is a query whose answer is the
  passage holding it, in the same language or the other one.
- Wikipedia (CC BY-SA 4.0), Nepali and English articles from the `wikimedia/wikipedia`
  parquet export, cut into 75-225 word passages at sentence ends (about one 30-90 s search
  chunk of speech). These are distractors. Nepali articles get a Nepali vector only, since
  they have no translation.

About 40% of the vectors are Nepali text and 60% English, the split a two-thirds-Nepali
archive has. Articles are written interleaved, so the first N interviews of the output are a
smaller corpus with the same mix. Vectors are written in shards as they are made, so an
interrupted run keeps what it finished; run again with the same arguments to continue.

Output in --out: `manifest.json`, `interviews.jsonl` (one interview per line, with its
passages), `labels.jsonl` (query, kind, target passage id) and `vectors-NNNN.npy` (float32,
in passage order).
"""

import argparse
import csv
import json
import os
import random
import re
import sys
import time
from collections.abc import Iterator, Sequence
from concurrent.futures import ProcessPoolExecutor
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np

SEED = 523
NEPALI_SHARE = 0.4
FLEURS_GROUP = 6
SHARD = 2048
_SENTENCE_END = re.compile(r"(?<=[.!?।॥])\s+")


@dataclass
class Passage:
    id: int
    language: str  # language of `original`
    original: str
    english: str | None  # human translation (FLEURS Nepali passages only)
    sentences: list[str]  # `original` cut at sentence ends: the archive's lines
    english_sentences: list[str] | None = None


@dataclass
class Interview:
    key: str
    source: str  # fleurs | wikipedia
    language: str
    title: str
    passages: list[Passage] = field(default_factory=list)


@dataclass(frozen=True)
class Label:
    query: str
    kind: str  # "<query language>-><passage language>", e.g. ne->en
    passage_id: int


def read_fleurs(directory: Path, language: str) -> dict[int, str]:
    csv.field_size_limit(sys.maxsize)
    sentences: dict[int, str] = {}
    for split in ("train", "dev", "test"):
        with (directory / f"{language}.{split}.tsv").open(encoding="utf-8") as f:
            for row in csv.reader(f, delimiter="\t", quoting=csv.QUOTE_NONE):
                sentences.setdefault(int(row[0]), row[2].strip())  # id, file, raw text
    return sentences


def split_passages(text: str, rng: random.Random) -> Iterator[list[str]]:
    """Paragraph text into lists of sentences of 75-225 words."""
    sentences = [s.strip() for s in _SENTENCE_END.split(" ".join(text.split())) if s.strip()]
    target, current, words = rng.randint(75, 225), [], 0
    for sentence in sentences:
        current.append(sentence)
        words += len(sentence.split())
        if words >= target:
            yield current
            target, current, words = rng.randint(75, 225), [], 0
    if words >= 75:
        yield current


def read_wikipedia(path: Path, language: str, rng: random.Random) -> Iterator[Interview]:
    import pyarrow.parquet as pq  # perf dependency group only

    for batch in pq.ParquetFile(path).iter_batches(batch_size=512, columns=["title", "text"]):
        for row in batch.to_pylist():
            # At most 60 passages: an hour of speech is about 60 one-minute chunks.
            passages = list(split_passages(row["text"], rng))[:60]
            if passages:
                interview = Interview(
                    f"wiki-{language}-{row['title']}", "wikipedia", language, row["title"]
                )
                interview.passages = [Passage(0, language, " ".join(p), None, p) for p in passages]
                yield interview


def fleurs_interviews(directory: Path) -> list[Interview]:
    nepali, english = read_fleurs(directory, "ne_np"), read_fleurs(directory, "en_us")
    ids = sorted(set(nepali) & set(english))
    groups = [ids[i : i + FLEURS_GROUP] for i in range(0, len(ids), FLEURS_GROUP)]
    interviews: list[Interview] = []
    for n, start in enumerate(range(0, len(groups), 10)):  # ten passages per interview
        language = "ne" if n % 2 == 0 else "en"
        interview = Interview(f"fleurs-{n}", "fleurs", language, f"FLEURS sentences {n + 1}")
        for group in groups[start : start + 10]:
            ne, en = [nepali[i] for i in group], [english[i] for i in group]
            interview.passages.append(
                Passage(0, "ne", " ".join(ne), " ".join(en), ne, en)
                if language == "ne"
                else Passage(0, "en", " ".join(en), None, en, ne)  # Nepali kept for queries
            )
        interviews.append(interview)
    return interviews


def build_labels(interviews: Sequence[Interview], rng: random.Random, per_kind: int) -> list[Label]:
    by_kind: dict[str, list[Label]] = {}
    for interview in interviews:
        if interview.source != "fleurs":
            continue
        for p in interview.passages:
            other = p.english_sentences or []  # the same sentences in the other language
            if p.language == "ne":  # Nepali passage with an English translation
                pairs = [("ne->ne", p.sentences), ("en->ne", other)]
            else:  # English passage; its Nepali versions are queries only
                pairs = [("en->en", p.sentences), ("ne->en", other)]
            for kind, sentences in pairs:
                by_kind.setdefault(kind, []).append(Label(rng.choice(sentences), kind, p.id))
    labels: list[Label] = []
    for kind in sorted(by_kind):
        labels += rng.sample(by_kind[kind], min(per_kind, len(by_kind[kind])))
    return labels


def vector_count(interview: Interview) -> int:
    return sum(2 if p.english else 1 for p in interview.passages)


def plan(args: argparse.Namespace) -> tuple[list[Interview], list[Label]]:
    rng = random.Random(SEED)  # noqa: S311 (test data, not secrets)
    fleurs = fleurs_interviews(args.fleurs)
    ordered = list(fleurs)
    counts = {"ne": 0, "en": 0}  # vectors of Nepali / English text so far
    for i in fleurs:
        for p in i.passages:
            counts[p.language] += 1
            if p.english:
                counts["en"] += 1
    sources = {
        "ne": read_wikipedia(args.wiki_ne, "ne", rng),
        "en": read_wikipedia(args.wiki_en, "en", rng),
    }
    while sum(counts.values()) < args.vectors:
        total = sum(counts.values()) or 1
        language = "ne" if counts["ne"] / total < NEPALI_SHARE else "en"
        interview = next(sources[language], None)
        if interview is None and language == "ne":
            # One Nepali Wikipedia export gives ~35k passages; past that the rest is English,
            # so only a prefix of the corpus keeps the 40/60 mix (see the manifest).
            print(f"Nepali Wikipedia used up at {total} vectors; English from here", flush=True)
            sources["ne"] = sources["en"]
            interview = next(sources["en"], None)
        if interview is None:
            raise SystemExit(f"Ran out of Wikipedia articles at {total} vectors")
        ordered.append(interview)
        counts[language] += vector_count(interview)
    number_passages(ordered)
    return ordered, build_labels(ordered, rng, args.queries_per_kind)


def number_passages(interviews: Sequence[Interview]) -> None:
    for n, p in enumerate(p for i in interviews for p in i.passages):
        p.id = n


# Texts embedded per passage, in order: the original, then the English translation if any.
def texts(interviews: Sequence[Interview]) -> list[str]:
    out: list[str] = []
    for interview in interviews:
        for p in interview.passages:
            out.append(p.original)
            if p.english:
                out.append(p.english)
    return out


_EMBEDDER = None


def _init_worker(model: str, model_dir: str, max_tokens: int) -> None:
    global _EMBEDDER
    from swayambhu_providers.local_provider import LocalOnnxEmbedder

    _EMBEDDER = LocalOnnxEmbedder(
        model,
        Path(model_dir),
        query_prefix="query: ",
        passage_prefix="passage: ",
        max_tokens=max_tokens,
        threads=1,
    )


def _embed(batch: list[str]) -> np.ndarray:
    if _EMBEDDER is None:
        raise RuntimeError("worker not initialised")
    return np.asarray(_EMBEDDER.embed(batch, "passage"), dtype=np.float32)


def embed_all(all_texts: list[str], out: Path, args: argparse.Namespace) -> None:
    shards = [all_texts[i : i + SHARD] for i in range(0, len(all_texts), SHARD)]
    todo = [n for n in range(len(shards)) if not (out / f"vectors-{n:04d}.npy").exists()]
    workers = args.workers or os.cpu_count() or 1
    began, done = time.monotonic(), 0
    with ProcessPoolExecutor(
        workers, initializer=_init_worker, initargs=(args.model, str(args.model_dir), 512)
    ) as pool:
        for n in todo:
            shard = shards[n]
            # Sorting by length cuts padding; the vectors are put back in passage order.
            order = sorted(range(len(shard)), key=lambda i: len(shard[i]))
            batches = [[shard[i] for i in order[j : j + 4]] for j in range(0, len(order), 4)]
            vectors = np.concatenate(list(pool.map(_embed, batches, chunksize=8)))
            result = np.empty_like(vectors)
            result[order] = vectors
            np.save(out / f"vectors-{n:04d}.npy", result)
            done += len(shard)
            rate = done / (time.monotonic() - began)
            print(f"shard {n + 1}/{len(shards)}: {rate:.0f} texts/s", flush=True)


def write_corpus(
    out: Path, manifest: dict[str, object], interviews: Sequence[Interview], labels: list[Label]
) -> None:
    old = out / "manifest.json"
    if old.exists() and json.loads(old.read_text()) != manifest:
        raise SystemExit(f"{out} holds a different corpus; use a new --out")
    old.write_text(json.dumps(manifest, indent=2))
    with (out / "interviews.jsonl").open("w", encoding="utf-8") as f:
        for interview in interviews:
            f.write(json.dumps(asdict(interview), ensure_ascii=False) + "\n")
    with (out / "labels.jsonl").open("w", encoding="utf-8") as f:
        for label in labels:
            f.write(json.dumps(asdict(label), ensure_ascii=False) + "\n")


def load_vectors(directory: Path) -> np.ndarray:
    return np.concatenate([np.load(p) for p in sorted(directory.glob("vectors-*.npy"))])


def read_corpus(directory: Path) -> tuple[dict[str, object], list[Interview], list[Label]]:
    manifest = json.loads((directory / "manifest.json").read_text())
    interviews = []
    with (directory / "interviews.jsonl").open(encoding="utf-8") as f:
        for line in f:
            raw = json.loads(line)
            raw["passages"] = [Passage(**p) for p in raw["passages"]]
            interviews.append(Interview(**raw))
    with (directory / "labels.jsonl").open(encoding="utf-8") as f:
        labels = [Label(**json.loads(line)) for line in f]
    return manifest, interviews, labels


def main(argv: Sequence[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--fleurs", type=Path, required=True, help="dir of <lang>.<split>.tsv")
    parser.add_argument("--wiki-ne", type=Path, required=True)
    parser.add_argument("--wiki-en", type=Path, required=True)
    parser.add_argument("--vectors", type=int, default=50_000, help="about this many vectors")
    parser.add_argument("--queries-per-kind", type=int, default=200)
    parser.add_argument("--model", default="intfloat/multilingual-e5-small")
    parser.add_argument(
        "--model-dir", type=Path, default=Path("/opt/models/intfloat/multilingual-e5-small")
    )
    parser.add_argument("--workers", type=int, help="embedding processes (default: all cores)")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)

    interviews, labels = plan(args)
    all_texts = texts(interviews)
    args.out.mkdir(parents=True, exist_ok=True)
    manifest = {
        "model": args.model,
        "dimensions": 384,
        "vectors": len(all_texts),
        "passages": sum(len(i.passages) for i in interviews),
        "interviews": len(interviews),
        "query_prefix": "query: ",
        "passage_prefix": "passage: ",
        "shard": SHARD,
        "sources": {
            "fleurs": str(args.fleurs),
            "wiki_ne": str(args.wiki_ne),
            "wiki_en": str(args.wiki_en),
        },
    }
    write_corpus(args.out, manifest, interviews, labels)
    print(
        f"{manifest['interviews']} interviews, {manifest['passages']} passages, "
        f"{len(all_texts)} texts to embed, {len(labels)} labelled queries",
        flush=True,
    )
    embed_all(all_texts, args.out, args)


if __name__ == "__main__":
    main()
