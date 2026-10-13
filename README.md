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

Web app (proxies `/api` to `localhost:8000`):

```sh
cd apps/web && npm install && npm run dev
```

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

Review every autogenerated migration before committing it. `docker compose up` runs `upgrade head` in a one-off `migrate` container before the API starts. On CloudApps, run it in the API pod after each deploy that adds a migration: `oc exec deploy/<api deployment> -- python -m swayambhu_api.migrate upgrade head`. A database created earlier from `db/init/002_admins.sql` is adopted by the first migration without changes.

Integration tests wipe tables and roll migrations back and forth, so they refuse to run unless the database name ends in `_test`:

```sh
createdb swayambhu_test && psql swayambhu_test -f db/init/001_extensions.sql
DATABASE_URL=postgresql://swayambhu@localhost:5432/swayambhu_test uv run pytest -m integration
```

## Deployment

The target is UNC Carolina CloudApps (OpenShift). Every image runs as a non-root, arbitrary UID and listens on 8080. OpenShift manifests aren't written yet. The plan is to serve the web app and API on one host, with `/api` routed to the API.

- **Web:** nginx sends a Content-Security-Policy, `nosniff`, Referrer-Policy, HSTS and Permissions-Policy on every response (`apps/web/security-headers.inc`). Hashed files under `/assets/` are cached for a year, and `index.html` is revalidated on every load. A new external host (Firebase sign-in, the media store) has to be added to the CSP, or the browser blocks it.
- **API behind the router:** uvicorn takes the client IP from `X-Forwarded-For` only when the request comes from an address in `FORWARDED_ALLOW_IPS` (default `127.0.0.1`). On CloudApps, set it on the api Deployment to the router's address range.
- **Base images** are updated by Dependabot. Python and nginx minor versions and Postgres major versions are moved by hand.

Project decisions are recorded in `decisions_log.md` in the team's handoff bundle.
