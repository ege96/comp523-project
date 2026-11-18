# Swayambhu Stories Searchable Archive

A search-first web archive of multilingual oral-history interviews about the Swayambhu stupa in Kathmandu. UNC COMP 523, with Dr. Lauren Leve (UNC Religious Studies) and Baakhan Nyane Waa.

Visitors search the interviews by meaning or by exact words, in English, Nepali or Nepal Bhasa, and open the recording at the moment where it is said. Admins upload recordings, which the worker turns into a streaming copy, a timestamped transcript, an English translation and a search index. Admins then correct transcripts and publish interviews. Private interviews are filtered out by the API on every route, never only in the browser.

| I want to... | Read |
|---|---|
| Run it on my machine | [Run locally](#run-locally) below |
| Understand how search, sign-in, uploads and the database work | [docs/architecture.md](docs/architecture.md) |
| Look up an environment variable | [docs/configuration.md](docs/configuration.md) |
| Deploy it, add admins, back it up | [docs/deploy-cloudapps.md](docs/deploy-cloudapps.md) |

Project decisions are recorded in `decisions_log.md` in the team's handoff bundle.

## Layout

| Path | What | Stack |
|---|---|---|
| `apps/web` | Public archive and admin UI | React + TypeScript + Vite, MUI |
| `services/api` | Archive API, authorization, search | FastAPI (Python 3.12) |
| `services/worker` | Background media processing (FFmpeg, transcription, translation, embeddings) | Python 3.12 |
| `packages/core` | Database models, job queue and media storage, shared by the API and worker | Python 3.12, SQLAlchemy 2 |
| `packages/providers` | Swappable transcription, translation and embedding providers | Python 3.12 |
| `db/init` | SQL run when a fresh local database starts (enables pgvector only; tables come from migrations) | PostgreSQL 16 + pgvector |
| `deploy/cloudapps` | OpenShift templates that deploy the whole archive to CloudApps | OpenShift Template |
| `docs` | Architecture, configuration, and the CloudApps deployment guide | Markdown |

Python projects use [uv](https://docs.astral.sh/uv/). Web tests use Vitest.

## Run locally

Database, API and worker in Docker, with offline fake AI providers (no keys needed):

```sh
docker compose up --build
curl localhost:8000/api/health/ready   # {"status":"ok","database":true,"pgvector":true}
```

Web app (Node 26, see `apps/web/.nvmrc`; proxies `/api` to `localhost:8000`):

```sh
cd apps/web && npm install && npm run dev
```

For admin sign-in, copy `apps/web/.env.example` to `apps/web/.env.local` and fill in the Firebase web config from `apps/web/.env.production` (it is public). Without it the site works, and the sign-in page says sign-in isn't available. To make yourself an admin:

```sh
docker compose run --rm api python -m swayambhu_api.manage_admins add you@example.org
```

<details>
<summary>Without Docker</summary>

You need a local Postgres 16 with pgvector (`db/init` enables the extension).

```sh
mkdir -p /absolute/path/to/media     # one writable folder, used by BOTH the API and the worker
cp .env.example services/api/.env && cp .env.example services/worker/.env
# In both .env files set the same absolute MEDIA_ROOT, e.g. MEDIA_ROOT=/absolute/path/to/media
cd services/api && uv sync && uv run python -m swayambhu_api.migrate upgrade head
uv run uvicorn swayambhu_api.main:app --reload          # listens on 8000
cd ../worker && uv sync && uv run python -m swayambhu_worker   # no HTTP listener
```

`MEDIA_ROOT` must be an absolute path and the same folder for both services: the API stores uploads there and the worker reads them.

</details>

## Working on the web app

- Routes: TanStack Router, listed in `apps/web/src/router.tsx`.
- Data: TanStack Query. Every API response is checked with zod schemas (`src/api/schemas.ts`), which are type-checked against `src/api/schema.gen.ts`, generated from the API. After changing an API route or response model, run `npm run gen:api` (needs uv) and commit the result.
- Theme (colors and typography): `apps/web/src/theme.ts`.

## Checks

CI runs on every PR. Treat these as required checks when you set up branch protection:

| Job | What it runs |
|---|---|
| `api`, `worker`, `core`, `providers` | ruff lint and format, mypy `--strict`, pytest with at least 80% coverage, `pip-audit` of runtime dependencies. The API job also runs integration tests against Postgres + pgvector. |
| `web` | ESLint (strict, type-checked), Prettier, `tsc`, Vitest with at least 80% coverage, Vite build, `npm audit` of runtime dependencies |
| `pre-commit` | Every hook in `.pre-commit-config.yaml`, including private-key and large-file checks |
| `docker` | hadolint on each Dockerfile, an image build with a layer cache, a run as an arbitrary non-root UID (like OpenShift), and the image size in the job summary |

Run the same checks before you commit:

```sh
uv tool install pre-commit && pre-commit install   # once
pre-commit run --all-files
```

Or by hand:

```sh
cd services/api    && uv run ruff check . && uv run mypy && uv run pytest --cov
cd services/worker && uv run ruff check . && uv run mypy && uv run pytest --cov
cd apps/web        && npm run lint && npm run typecheck && npm run test:coverage
```

Integration tests need a database whose name ends in `_test`; see [docs/architecture.md](docs/architecture.md#database-and-migrations).

Dependabot opens one grouped PR a week for uv, npm, GitHub Actions and Docker base images (`.github/dependabot.yml`). Security updates arrive as their own PRs while Dependabot alerts are on in the repository settings.

## Deployment

The target is UNC Carolina CloudApps (OpenShift). `deploy/cloudapps/setup.yaml` creates the Secrets and volumes once, and `app.yaml` creates or updates everything else with one command:

```sh
oc process -f deploy/cloudapps/app.yaml --param-file=deploy/cloudapps/app.env | oc apply -f -
```

[docs/deploy-cloudapps.md](docs/deploy-cloudapps.md) has every step, plus day-to-day jobs, backups and troubleshooting.
