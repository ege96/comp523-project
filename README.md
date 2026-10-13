# Swayambhu Stories Searchable Archive

A search-first web archive of multilingual oral-history interviews about the Swayambhu stupa in Kathmandu. UNC COMP 523, with Dr. Lauren Leve (UNC Religious Studies) and Baakhan Nyane Waa.

This is a skeleton: each service starts and reports health, and nothing else exists yet.

## Layout

| Path | What | Stack |
|---|---|---|
| `apps/web` | Public archive and admin UI | React + TypeScript + Vite, MUI |
| `services/api` | Archive API, authorization, search | FastAPI (Python 3.12) |
| `services/worker` | Background media processing (FFmpeg, transcription, translation, embeddings) | Python 3.12 |
| `db/init` | SQL run when a fresh local database starts (enables pgvector) | PostgreSQL 16 + pgvector |

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
| `docker` | Builds all three images without pushing them |

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

## Deployment

The target is UNC Carolina CloudApps (OpenShift). Every image runs as a non-root, arbitrary UID and listens on 8080. OpenShift manifests aren't written yet. The plan is to serve the web app and API on one host, with `/api` routed to the API.

Project decisions are recorded in `decisions_log.md` in the team's handoff bundle.
