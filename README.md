# Swayambhu Stories Searchable Archive

A search-first web archive of multilingual oral-history interviews about the Swayambhu stupa in Kathmandu. UNC COMP 523, with Dr. Lauren Leve (UNC Religious Studies) and Baakhan Nyane Waa.

[![CI](https://github.com/ege96/comp523-project/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/ege96/comp523-project/actions/workflows/ci.yml)

Admins upload hour-long recordings; a background worker transcribes, translates to English and indexes them; visitors search across languages and land on the timestamped moment in the recording. Keyword and semantic (pgvector) search are fused into one ranked list, and Private interviews never leave the server.

## Layout

| Path | What | Stack |
|---|---|---|
| `apps/web` | Public archive and admin UI | React + TypeScript + Vite, MUI |
| `services/api` | Archive API, authorization, search | FastAPI (Python 3.12) |
| `services/worker` | Background media processing (FFmpeg, transcription, translation, embeddings) | Python 3.12 |
| `db/init` | SQL run when a fresh local database starts (enables pgvector only; tables come from migrations) | PostgreSQL 16 + pgvector |

Python projects use [uv](https://docs.astral.sh/uv/). Web tests use Vitest.

## Run locally

Database, API, and worker in Docker:

```sh
docker compose up --build
curl localhost:8000/api/health/ready   # {"status":"ok","database":true,"pgvector":true}
```

Web app (Node 26, see `apps/web/.nvmrc`; proxies `/api` to `localhost:8000`):

```sh
cd apps/web && npm install && npm run dev
```

Admin sign-in needs the Firebase web config. It is public by design and committed in `apps/web/.env.production`, which production builds and the web image read. For `npm run dev`, copy `apps/web/.env.example` to `apps/web/.env.local` and fill in the same values. Without them the site works, and the sign-in page says sign-in isn't available.

The web app is a TanStack Router single-page app (`src/router.tsx` lists the routes). It fetches with TanStack Query and checks every API response with zod schemas (`src/api/schemas.ts`) that are type-checked against `src/api/schema.gen.ts`, which is generated from the API. After changing an API route or response model, run `npm run gen:api` (needs uv) and commit the result.

Without Docker, run each service directly:

```sh
cd services/api && uv sync && uv run uvicorn swayambhu_api.main:app --reload
cd services/worker && uv sync && uv run python -m swayambhu_worker
```

## Testing

Every PR runs the full suite in CI. Python tests run against a real PostgreSQL 16 + pgvector service container, not mocks, and every AI provider has an offline fake, so CI never calls a paid API.

| Layer | Where | What it proves |
|---|---|---|
| Unit | `services/*/tests`, `packages/*/tests`, `apps/web/src/**/*.test.ts(x)` | Token verification (forged, unsigned and HS256 tokens rejected), chunking, text fingerprints, provider adapters, React components and hooks (Vitest + Testing Library) |
| Integration (`-m integration`) | `services/api/tests/*_integration.py`, `services/worker/tests/*_integration.py` | Each route against Postgres: visibility on every listing, search hit, transcript and media link (an anonymous visitor never reaches Private content), migrations up and down, the worker pipeline end to end on generated audio with FFmpeg |
| Authorization sweep | `services/api/tests/test_auth.py` | Walks every registered route: anything not on the public list must answer 401 to anonymous and 403 to non-admin requests, so a new route can't ship unprotected |
| Search quality | `python -m swayambhu_api.search_eval` | Recall@5 and MRR for keyword, semantic and hybrid search on a labelled query set ([below](#measuring-search-quality-proposal)) |
| Performance | `python -m swayambhu_api.perf.*`, `perf/` | Latency at 1x/10x/30x archive sizes, an HNSW index experiment, and a k6 load test at the CloudApps pod size ([below](#performance-proposal)) |

Coverage gates: at least 80% (branch coverage) for each Python project and the web app; each CI job writes its coverage table to the job summary.

| CI job | What it runs |
|---|---|
| `api`, `worker`, `core`, `providers` | ruff lint and format, mypy `--strict`, pytest (unit and integration) with coverage, `pip-audit` on runtime dependencies. `api` also checks the models match the migrations. |
| `web` | ESLint (strict, type-checked), Prettier, `tsc`, Vitest with coverage, `npm audit`, Vite build |
| `pre-commit` | Every hook in `.pre-commit-config.yaml`, including private-key and large-file checks |
| `docker` | hadolint, an image build with a layer cache, a smoke run as an arbitrary non-root UID (like OpenShift), image size in the job summary |
| `Performance` (optional) | Seeds the 1x archive, fails if search p95 is over 1 s, then a 1-minute k6 load run |

To run the checks before you commit:

```sh
uv tool install pre-commit && pre-commit install   # once
pre-commit run --all-files
```

To run the tests by hand (integration tests need a Postgres with pgvector whose database name ends in `_test`, so a real database can't be wiped):

```sh
export DATABASE_URL=postgresql://swayambhu@localhost:5432/swayambhu_test
cd services/api    && uv run pytest --cov -m ""     # -m "" includes integration tests
cd services/worker && uv run pytest --cov -m ""     # needs ffmpeg on PATH
cd packages/core   && uv run pytest --cov
cd apps/web        && npm run lint && npm run typecheck && npm run test:coverage
```

Dependabot opens weekly grouped update PRs for uv, npm, and GitHub Actions.

## Health endpoints

- `GET /api/health`: the process is up. Doesn't touch the database.
- `GET /api/health/ready`: Postgres is reachable and the `vector` extension is installed. Returns 503 otherwise.

## Search

`GET /api/search?q=...` returns transcript moments, best first: each has its interview, a start and end time, and an excerpt of about 30 s of transcript lines to seek to. Keyword search (Postgres full-text) and semantic search (the query's embedding against stored chunk embeddings) are merged by reciprocal rank fusion. There is no match count, only `has_more`. Optional filters: `language` (any language heard), `interviewee` (an id, or `unknown`), `recorded_from`/`recorded_to` (`undated=true` also keeps interviews with no date). `GET /api/search/filters` lists the languages and interviewees a viewer can filter by. Both filter by visibility like every other route. The API embeds queries with the same `EMBEDDING_*` settings the worker uses; if the provider fails or takes longer than `SEARCH_EMBEDDING_TIMEOUT_SECONDS` (default 5; remote providers only), results are keyword-only and the response says `"search_mode": "keyword_only"`. Each moment's `matched_by` says which searches found it. `SEARCH_CANDIDATES`, `SEARCH_RRF_K` and `SEARCH_EXCERPT_MS` tune the ranking and excerpts.

`EMBEDDING_PROVIDER=local` (Proposal) embeds on CPU inside the API and worker with ONNX Runtime, so search needs no API call. The api and worker images bake in `intfloat/multilingual-e5-small` under `/opt/models` at build time (`--build-arg EMBEDDING_MODEL=` leaves it out). Set `EMBEDDING_MODEL=intfloat/multilingual-e5-small`, `EMBEDDING_QUERY_PREFIX="query: "`, `EMBEDDING_PASSAGE_PREFIX="passage: "` and leave `EMBEDDING_DIMENSIONS` empty (the model fixes it at 384). Text past `LOCAL_EMBEDDING_MAX_TOKENS` (default 512, the model's limit) is cut off before embedding; keyword search still covers it. `LOCAL_EMBEDDING_THREADS` (default 4) should match the pod's CPU limit. Measured on CloudApps (1 CPU, 1 thread): the model takes about 400 MiB, queries about 20 ms, and the worker peaks around 540 MiB at `LOCAL_EMBEDDING_BATCH_SIZE` 4 (the default), so 768Mi limits fit both api and worker. Changing the model means the worker has to re-index, because search only compares vectors from the configured model.

### Measuring search quality (Proposal)

`python -m swayambhu_api.search_eval <set.json>` (in `services/api`) runs a labelled query set through keyword, semantic and hybrid search and prints Recall@5 and MRR per mode, overall and by query language and kind (`--k` changes the cut-off, `--json` prints every query). A set can carry its own interviews, which are chunked and embedded like the worker does, searched on their own and rolled back, so nothing is saved; otherwise its labels name existing interview ids and the whole archive is searched as an admin sees it. It uses the configured `EMBEDDING_*` settings and refuses `openai` without `--allow-paid`. `services/api/eval/search_synthetic.json` is a small **synthetic** set (made-up English and AI-written Nepali, no Nepal Bhasa) that only checks the harness: replace it with queries labelled against real or consented pilot transcripts before tuning anything.

```bash
cd services/api
EMBEDDING_PROVIDER=local EMBEDDING_MODEL=intfloat/multilingual-e5-small \
  EMBEDDING_QUERY_PREFIX="query: " EMBEDDING_PASSAGE_PREFIX="passage: " \
  uv run python -m swayambhu_api.search_eval eval/search_synthetic.json
```

### Performance (Proposal)

`python -m swayambhu_api.perf.seed --scale N` fills a scratch `*_perf` database with N x 30 synthetic one-hour interviews (placeholder words, random 384-dim vectors, half Private) straight through COPY: 30x, 1.6 million lines, takes about 80 s. `python -m swayambhu_api.perf.bench` then measures:

- `latency --url ...`: each of the 50 queries in `perf/queries.txt` (words, phrases, filtered), 20 times, over HTTP: median, p95, p99.
- `split`: the keyword SQL and the vector SQL timed apart.
- `k6 <csv>`: per-step results of a `k6 run -e PROFILE=ceiling --out csv=<csv> perf/search_load.js` run.
- `ann`: exact vector search against temporary HNSW indexes (`vector` and `halfvec`) on the search's own query as a visitor: latency, overlap with exact search, index size and build time, and with `--corpus` the recall of labelled queries.

For real text and vectors instead of placeholders: `perf/download_corpus_sources.sh data` fetches FLEURS transcripts (Nepali and English, CC BY 4.0) and Nepali and English Wikipedia (CC BY-SA 4.0), about 460 MB. `uv run --group perf python -m swayambhu_api.perf.corpus --fleurs data/fleurs --wiki-ne data/wiki/ne.parquet --wiki-en data/wiki/en0.parquet --vectors 90000 --out data/corpus` cuts them into 75-225 word passages (one 30-90 s chunk of speech each) and embeds them with e5-small. That takes about 75 minutes for 90,000 vectors on 4 CPUs, and an interrupted run continues where it stopped. `perf.seed --corpus data/corpus --vectors N` then loads the first N vectors' worth. FLEURS has the same ~2,000 sentences in both languages, so it supplies 654 labelled queries (Nepali and English, same-language and cross-language). Wikipedia supplies the distractors, plus short labelled queries: article titles, answered by any passage of that article. `--labels-only` rewrites the labels without embedding. About 40% of the vectors are Nepali text, as in a two-thirds-Nepali archive. Run the seeder, the API and `bench` with `EMBEDDING_PROVIDER=local EMBEDDING_MODEL=intfloat/multilingual-e5-small` and the e5 prefixes.

`perf/search_load.js` is a k6 load test (ramp to 50 users; `PROFILE=smoke` holds 10 users for a minute) for the API run with the CloudApps pod's limits, `perf/compose.perf.yaml` (1 CPU, 768 MiB). The optional `Performance` CI workflow runs the 1x latency check and the k6 smoke run. Don't load-test the live CloudApps site: it's a shared cluster.

Results on a development container (PostgreSQL 16, fake embedder, so these are database and API costs, not the embedding call; 2026-11-06):

| Archive | Lines | Vectors | Search p50 | Search p95 | Keyword SQL p50 | Vector SQL p50 |
|---|---|---|---|---|---|---|
| 1x (30 h) | 54,000 | 3,000 | 29 ms | 35 ms | 16 ms | 4 ms |
| 10x (300 h) | 540,000 | 30,000 | 73 ms | 92 ms | 21 ms | 21 ms |
| 30x (900 h) | 1,620,000 | 90,000 | 137 ms | 177 ms | 55 ms | 55 ms |

What it found:

- **Keyword search scanned every line.** Matching English words against lines with no English text (English speech, failed translations) had no index, so each search read the whole `segments` table: 380 ms of keyword SQL at 10x. Migration 0008 adds a partial expression index for it (`segments_untranslated_tsv_idx`), and the same query now takes 21 ms.
- **On random vectors HNSW looked useless** (0.23 of the exact top 10 at `ef_search` 200). Real embeddings, below, tell a different story.

Results with real text and e5-small vectors (2026-11-06; the API pinned to 1 CPU, like the CloudApps pod, and PostgreSQL to another, with its defaults: `shared_buffers` 128 MB, `maintenance_work_mem` 64 MB). The vector query is the nearest 100 chunks as a visitor, over 948 queries: 654 labelled FLEURS sentences, 249 labelled Wikipedia titles (1-4 words) and the 45 unfiltered queries in `perf/queries.txt`. HNSW here is `halfvec` at `ef_search` 1000:

| Archive | Vectors | Search p50 / p95 over HTTP (query embedding included) | Exact vector SQL p50 / p95 | HNSW p50 | HNSW overlap with exact top 10 | Labelled recall@10, exact / HNSW |
|---|---|---|---|---|---|---|
| 1x | 3,052 | 35 / 42 ms | 5.2 / 8.8 ms | 5.3 ms | 1.000 | 0.891 / 0.891 |
| 10x | 30,012 | 66 / 93 ms | 20 / 26 ms | 11.8 ms | 0.998 | 0.827 / 0.823 |
| 30x | 90,000 | 172 / 238 ms | 111 / 129 ms | 15.9 ms | 0.993 | 0.785 / 0.779 |

At `ef_search` 100, recall at 30x fell to 0.738. Building with `m` 24 and `ef_construction` 200 (measured before the query rewrite below) took overlap from 0.989 to 0.997, at 2.5x the build time. At 30x the index is 176 MB as `vector` and 100 MB as `halfvec`, and the vectors themselves take 133 MB, or 67 MB as `halfvec`. Builds took 80-100 s and passed `maintenance_work_mem` at about 28,000 vectors. The API's memory peaked at 613 MiB, inside its 768 MiB limit.

Load (`k6 ... PROFILE=ceiling`, 10x archive, 1 to 30 searches a second in one-minute steps, `bench k6` per step):

| Vector query | Most searches/s with p95 under 250 ms | Searches at 1-10/s, p50 | Past the ceiling |
|---|---|---|---|
| Before (grouped whole rows) | about 10 | 125-155 ms | at 13/s requests queued until they hit 60 s timeouts, and the pod didn't recover while load continued |
| After (`nearest_chunks`) | about 24 | 58-65 ms | p95 1.6 s at 29/s, no errors |

What it found:

- **The vector query was the hotspot, and it is fixed.** With py-spy under load, 84% of request time was waiting on the vector SQL; the query embedding took 5%. The plan grouped every 1.5 KB embedding row by chunk before computing distances, so the sort spilled to disk and used three parallel workers. `search.nearest_chunks` now takes the nearest 2 x N embeddings first and groups only those. It is still exact, because a chunk has at most two embeddings. The query went from 198 to 95 ms on one CPU at 10x, and one pod's ceiling went from about 10 to about 24 searches a second.
- **Exact search is fine through 30x.** The whole search's p95 is 238 ms on one database CPU, far under the 5 s target. Keep exact search (P-015).
- **When it's needed, use HNSW on `halfvec` with `ef_search` near 1000.** It matches `vector` on recall, with a 43% smaller index and faster queries, which matters with a 512 MiB database pod. It cuts the 30x vector SQL from 111 to 16 ms and loses 0.006 of labelled recall. `nearest_chunks` is already the shape an index can serve: add an index on `embedding::halfvec(384)`, cast the distance the same way, and set `hnsw.iterative_scan = relaxed_order` so the visitor filter doesn't empty the results. Do it around 30x, or when exact vector SQL passes about 100 ms.
- **Running keyword and vector SQL at the same time isn't worth it.** Keyword SQL is 19 ms against 119 ms for vector at 30x, so overlapping them would save under 20 ms per search. On a one-CPU database it adds no throughput, and it needs a second connection per request.
- **Overload doesn't fail fast.** Past the ceiling, requests queue behind the database pool for up to a minute. Follow-up: a Postgres `statement_timeout`, or a shorter pool timeout, so a busy pod returns errors quickly instead of hanging.
- **Recall falls as the archive grows,** even with exact search: from 0.89 at 1x to 0.79 at 30x. That is e5-small's quality, not the index's. Nepali query to English passage is the weakest (0.59 at 30x). The title queries are near 1.0 because titles usually appear in their own passages, so the sentence pairs are the harder test. Use these numbers as the baseline for the model and translation-pivot comparison (D-015). The corpus is Wikipedia prose and read FLEURS sentences, not interview speech, so re-check against real or pilot transcripts.

## Sign-in and admins

Public visitors don't sign in. Admins sign in with Firebase Authentication, and the web app sends the Firebase ID token as `Authorization: Bearer <token>`. The API checks the token's signature against Google's published keys and that it was issued for `FIREBASE_PROJECT_ID`. Firebase only says who someone is. Whether they are an admin is decided by the `admins` table in Postgres.

- `GET /api/auth/me` returns the signed-in admin. It returns 401 with no token or a bad one, 403 for a valid sign-in that isn't an admin, and 503 if `FIREBASE_PROJECT_ID` isn't set.
- In code, admin-only routes take `CurrentAdmin`. Routes that serve both the public and admins take `CurrentViewer` and must filter out Private content when `viewer.is_admin` is false. A test fails if any route outside the public list answers an anonymous request.

Admins are added by email from the command line. The person becomes an admin the first time they sign in with that email, as long as Firebase reports the email as verified. After that, their Firebase account is what identifies them.

```sh
docker compose run --rm api python -m swayambhu_api.manage_admins add you@example.org
docker compose run --rm api python -m swayambhu_api.manage_admins list
docker compose run --rm api python -m swayambhu_api.manage_admins remove you@example.org
```

On CloudApps, run the same command with `oc exec deploy/<api deployment> -- python -m swayambhu_api.manage_admins ...`.

In the web app, the footer links to `/signin` (Sign in with Google, in a popup). Firebase is only downloaded by browsers that open the sign-in page or were signed in before, so public visitors never load it. The web app asks `GET /api/auth/me` whether the account is an admin, and shows the admin pages only then. That is only for the UI: the API checks the token on every admin request.

## Uploading recordings

Admins upload recordings with the [tus](https://tus.io) resumable-upload protocol at `/api/uploads` (Proposal; served by `tuspyserver`). If the connection drops, the upload resumes from the last byte the server has rather than starting again. The web app uses `tus-js-client`. Every route needs an admin token.

In the web app, admins do all of this from **Upload & review** (`/admin`): pick or drop a file, fill in what is known, and watch the progress bar. A dropped connection retries on its own, and pressing Upload again with the same file and details resumes rather than restarting. The same page lists every interview with its status and a Public/Private switch; each interview's page (`/admin/interviews/{id}`) shows its processing steps and errors.

1. `POST /api/uploads` with `Upload-Length` and `Upload-Metadata`, and no body. The metadata keys are `title`, `filename` and `filetype` (all required), plus optional `language` (`en`, `ne`, `new`), `interviewee_id` or `interviewee_name`, and `recorded_on` (`YYYY`, `YYYY-MM` or `YYYY-MM-DD`). Bad metadata is refused here, before any bytes are sent.
2. `PATCH` the returned `Location` in chunks of at most `UPLOAD_CHUNK_MAX_BYTES` (64 MiB). `HEAD` on it tells you where to resume.
3. The last PATCH's response has the new interview's id in `Upload-Interview-Id`. The interview is Private, and its processing is already queued.

From a script, the Python client `tuspy` resumes and chunks for you:

```python
from tusclient import client  # pip install tuspy

tus = client.TusClient("https://<host>/api/uploads", headers={"Authorization": f"Bearer {token}"})
tus.uploader(
    "talk.mp3",
    chunk_size=32 * 1024 * 1024,
    metadata={"title": "Interview with ...", "filename": "talk.mp3", "filetype": "audio/mpeg"},
).upload()
```

With curl, a file smaller than one chunk is two requests (metadata values are base64):

```sh
b64() { printf %s "$1" | base64 -w0; }
curl -i -X POST https://<host>/api/uploads -H "Authorization: Bearer $TOKEN" -H "Tus-Resumable: 1.0.0" \
  -H "Upload-Length: $(stat -c%s talk.mp3)" \
  -H "Upload-Metadata: title $(b64 'Interview'),filename $(b64 talk.mp3),filetype $(b64 audio/mpeg)"
curl -i -X PATCH "<Location from above>" -H "Authorization: Bearer $TOKEN" -H "Tus-Resumable: 1.0.0" \
  -H "Upload-Offset: 0" -H "Content-Type: application/offset+octet-stream" --data-binary @talk.mp3
```

Unfinished uploads sit in `<MEDIA_ROOT>/uploads` and the worker deletes them after `UPLOAD_RETENTION_DAYS` (3) without a new chunk. For bulk loads on the server itself, `python -m swayambhu_worker.ingest FILE --title ...` skips HTTP entirely.

After changing the embedding model (`EMBEDDING_PROVIDER`, `EMBEDDING_MODEL` or `EMBEDDING_DIMENSIONS`) on both api and worker, run `python -m swayambhu_worker.reindex` in the worker pod. It queues an index job for every transcribed interview that has no vectors from the new model (`--dry-run` lists them first). Until those jobs finish, semantic search can't find those interviews, but keyword search still can.

Admins publish or hide an interview with `PATCH /api/interviews/{id}` `{"visibility": "public"}`, follow its processing with `GET /api/interviews/{id}/jobs`, and list by status with `GET /api/interviews?status=processing`.

Admins correct transcripts with `PATCH /api/interviews/{id}/segments/{seq}` (machine text is kept beside the edit) and see both with `GET /api/interviews/{id}/transcript`. Editing the words of an original makes its English out of date: a `retranslate` job refreshes those lines in one batch `RETRANSLATE_DELAY_SECONDS` (300) after the last edit, or at once with `POST /api/interviews/{id}/retranslate`. Spacing and punctuation alone don't count, and an admin's English edit is never overwritten; it's flagged for checking instead.

## Logs and request IDs

The API writes one JSON object per line to stdout (`LOG_FORMAT=json`, the default), which OpenShift collects. Set `LOG_FORMAT=text` for readable local output and `LOG_LEVEL` to change the level. Every response carries an `X-Request-ID`: the caller's own if it is a short token of letters, digits, `.`, `_` or `-`, otherwise a new one. Every log line written during that request includes it. Each request gets one access line with the method, path (no query string), status, duration and client IP. Headers, tokens and search terms are never logged. An unhandled error is logged with its stack and returns `500 {"detail": "Internal error", "request_id": "..."}`, so a reported ID leads straight to the trace.

## Database and migrations

The API talks to Postgres through SQLAlchemy 2 (ORM models in `services/api/src/swayambhu_api/models.py`), with one connection pool per process and one session per request (`DbSession` in `db.py`). Tables are created and changed only by Alembic migrations in `swayambhu_api/migrations/versions`. `db/init` only enables the `vector` extension, which needs a database superuser.

```sh
cd services/api
uv run python -m swayambhu_api.migrate upgrade head                       # apply migrations
uv run python -m swayambhu_api.migrate revision --autogenerate -m "add x"  # after changing models.py
uv run python -m swayambhu_api.migrate check                              # models and migrations agree
```

Review every autogenerated migration before committing it. The API container runs `upgrade head` itself on every start (`services/api/start.sh`), locally and on CloudApps, so a deploy never needs a manual migration step. Pods starting together take turns through a Postgres advisory lock. If a migration fails, the container exits and OpenShift keeps the previous pod serving. Set `RUN_MIGRATIONS=0` to skip it. Write migrations that the previous release can still run against (add columns before using them, drop them a release later), because the old pod keeps serving while the new one starts. A database created earlier from `db/init/002_admins.sql` is adopted by the first migration without changes.

Integration tests wipe tables and roll migrations back and forth, so they refuse to run unless the database name ends in `_test`:

```sh
createdb swayambhu_test && psql swayambhu_test -f db/init/001_extensions.sql
DATABASE_URL=postgresql://swayambhu@localhost:5432/swayambhu_test uv run pytest -m integration
```

## Deployment

The target is UNC Carolina CloudApps (OpenShift). Every image runs as a non-root, arbitrary UID and listens on 8080. OpenShift manifests aren't written yet. The plan is to serve the web app and API on one host, with `/api` routed to the API.

- **Web:** nginx sends a Content-Security-Policy, `nosniff`, Referrer-Policy, HSTS and Permissions-Policy on every response (`apps/web/security-headers.inc`). Hashed files under `/assets/` are cached for a year, and `index.html` is revalidated on every load. A new external host (Firebase sign-in, the media store) has to be added to the CSP, or the browser blocks it.
- **API behind the router:** uvicorn takes the client IP from `X-Forwarded-For` only when the request comes from an address in `FORWARDED_ALLOW_IPS` The API image sets it to `*`, because only the OpenShift router can reach the pod. Override it on the Deployment if the API is ever exposed another way.
- **Base images** are updated by Dependabot. Python and nginx minor versions and Postgres major versions are moved by hand.

Project decisions are recorded in `decisions_log.md` in the team's handoff bundle.
