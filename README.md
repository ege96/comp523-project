# Swayambhu Stories Searchable Archive

A search-first web archive of multilingual oral-history interviews about the Swayambhu stupa in Kathmandu. UNC COMP 523, with Dr. Lauren Leve (UNC Religious Studies) and Baakhan Nyane Waa.

This is a skeleton: each service starts and reports health, and nothing else exists yet.

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

## Checks

CI runs on every PR. Treat these as required checks when you set up branch protection:

| Job | What it runs |
|---|---|
| `api`, `worker` | ruff lint and format, mypy `--strict`, pytest with at least 80% coverage. The API job also runs an integration test against Postgres + pgvector. |
| `web` | ESLint (strict, type-checked), Prettier, `tsc`, Vitest with at least 80% coverage, Vite build |
| `pre-commit` | Every hook in `.pre-commit-config.yaml`, including private-key and large-file checks |
| `docker` | Runs hadolint on each Dockerfile, builds the image with a layer cache, runs it as an arbitrary non-root UID (like OpenShift does), and writes the image size to the job summary |

To run the same checks before you commit:

```sh
uv tool install pre-commit && pre-commit install   # once
pre-commit run --all-files
```

To run them by hand:

```sh
cd services/api    && uv run ruff check . && uv run mypy && uv run pytest --cov
cd services/worker && uv run ruff check . && uv run mypy && uv run pytest --cov
cd apps/web        && npm run lint && npm run typecheck && npm run test:coverage
```

Dependabot opens weekly grouped update PRs for uv, npm, and GitHub Actions.

## Health endpoints

- `GET /api/health`: the process is up. Doesn't touch the database.
- `GET /api/health/ready`: Postgres is reachable and the `vector` extension is installed. Returns 503 otherwise.

## Search

`GET /api/search?q=...` returns transcript moments, best first: each has its interview, a start and end time, and an excerpt of about 30 s of transcript lines to seek to. Keyword search (Postgres full-text) and semantic search (the query's embedding against stored chunk embeddings) are merged by reciprocal rank fusion. There is no match count, only `has_more`. Optional filters: `language` (any language heard), `interviewee` (an id, or `unknown`), `recorded_from`/`recorded_to` (`undated=true` also keeps interviews with no date). `GET /api/search/filters` lists the languages and interviewees a viewer can filter by. Both filter by visibility like every other route. The API embeds queries with the same `EMBEDDING_*` settings the worker uses; if the provider fails or takes longer than `SEARCH_EMBEDDING_TIMEOUT_SECONDS` (default 5), results are keyword-only and the response says `"search_mode": "keyword_only"`. Each moment's `matched_by` says which searches found it. `SEARCH_CANDIDATES`, `SEARCH_RRF_K` and `SEARCH_EXCERPT_MS` tune the ranking and excerpts.

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

Admins publish or hide an interview with `PATCH /api/interviews/{id}` `{"visibility": "public"}`, follow its processing with `GET /api/interviews/{id}/jobs`, and list by status with `GET /api/interviews?status=processing`.

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
