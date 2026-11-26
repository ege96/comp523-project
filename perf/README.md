# Performance tests (Proposal)

Development-only tools for measuring search, the worker and media playback under the CloudApps pods' limits. They are a separate project (`cd perf && uv sync`), so none of it ships in an image. Results are in [RESULTS.md](RESULTS.md).

Don't load-test the live CloudApps site: it is a shared UNC cluster and our quota is small.

## The environment

`compose.perf.yaml` runs Postgres and the API with the limits in `deploy/cloudapps/app.yaml`: db 0.5 CPU / 512 MiB, api 1 CPU / 768 MiB with the local e5-small embedder on one thread. Each container is pinned to its own core, and the load generator runs on the other cores.

```sh
docker compose -p perf -f perf/compose.perf.yaml up -d db
docker compose -p perf -f perf/compose.perf.yaml up -d api        # applies migrations
docker compose -p perf -f perf/compose.perf.yaml exec api cat /sys/fs/cgroup/cpu.max  # check
```

`API_IMAGE=<tag>` runs another build of the API against the same data, for before/after comparisons.

## Test data

Two kinds of archive, both written straight into Postgres with COPY (no worker), into a database whose name ends in `_perf` or `_test` (the seeder deletes every interview first):

- **Synthetic** (`python -m swayambhu_perf.seed --scale N`): N x 30 one-hour interviews of placeholder words and random 384-dim vectors, half Private. Quick, but random vectors say nothing about vector indexes.
- **Real text** (`perf.seed --corpus DIR --vectors N`): Nepali and English passages with their e5-small vectors. Build the corpus once:

  ```sh
  ./download_corpus_sources.sh data   # FLEURS (CC BY 4.0) + Wikipedia ne/en (CC BY-SA 4.0), ~460 MB
  uv run python -m swayambhu_perf.corpus --fleurs data/fleurs --wiki-ne data/wiki/ne.parquet \
      --wiki-en data/wiki/en0.parquet --vectors 90000 --out data/corpus \
      --model-dir <dir with the e5-small model.onnx and tokenizer.json>
  ```

  FLEURS has the same ~2,000 sentences in both languages, so it supplies labelled queries (Nepali and English, same- and cross-language). Wikipedia supplies distractor passages and short labelled queries (article titles). About 40% of the vectors are Nepali text. Archive sizes are counted in vectors: 1x is about 3,000 (30 hours of interviews), 10x 30,000, 30x 90,000. Run the seeder with `EMBEDDING_PROVIDER=local EMBEDDING_MODEL=intfloat/multilingual-e5-small`, like the API.

## Measurements

```sh
# Search over HTTP: one warm-up pass, then --runs passes of every query, one at a time
uv run python -m swayambhu_perf.bench latency --url http://localhost:8000 --corpus data/corpus --runs 3
# The keyword SQL and the vector SQL timed apart (in process)
uv run python -m swayambhu_perf.bench split --corpus data/corpus --runs 3
# Exact vs HNSW (vector and halfvec) on the search's vector query: latency, overlap with
# exact, labelled recall, index size and build time. Builds the indexes, then drops them.
uv run python -m swayambhu_perf.bench ann --corpus data/corpus --ef-search 40,100,200,400,1000
# Load: requests per second rising in one-minute steps; then per-step results
k6 run -e API_URL=http://localhost:8000 -e PROFILE=ceiling -e MAX_RPS=30 --out csv=k6.csv search_load.js
uv run python -m swayambhu_perf.bench k6 k6.csv
```

Percentiles are computed over every timed request (`statistics.quantiles`, inclusive). Latency is measured by the client, so it includes HTTP and, for search, embedding the query on the API's one CPU.

`search_load.js` has three profiles: `ceiling` (arrival rate stepping up to `MAX_RPS`, no think time: finds the most one pod serves), `full` (ramp to 50 users with 1-3 s think time) and `smoke` (10 users for a minute).
