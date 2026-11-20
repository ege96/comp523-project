# How the archive works

How the pieces behave, for developers. Settings named here are listed with their defaults in [configuration.md](configuration.md). Deployment steps are in [deploy-cloudapps.md](deploy-cloudapps.md).

- [Visibility](#visibility)
- [Sign-in and admins](#sign-in-and-admins)
- [Uploading recordings](#uploading-recordings)
- [Processing: transcription, translation, embeddings](#processing-transcription-translation-embeddings)
- [Editing and publishing](#editing-and-publishing)
- [Search](#search)
- [Health, logs and request IDs](#health-logs-and-request-ids)
- [Database and migrations](#database-and-migrations)
- [Web and API hardening](#web-and-api-hardening)

## Visibility

Interviews are Public or Private. New uploads are Private. Every route that returns interviews, segments, search hits or media filters out Private content on the server when the viewer isn't an admin.

- Admin-only routes take `CurrentAdmin`.
- Routes that serve both the public and admins take `CurrentViewer` and must filter by `viewer.is_admin`.
- A test fails if any route outside the public list answers an anonymous request.

## Sign-in and admins

Public visitors don't sign in. Admins sign in with Firebase Authentication. Firebase only says who someone is; whether they are an admin is decided by the `admins` table in Postgres.

- The web app sends the Firebase ID token as `Authorization: Bearer <token>`. The API checks its signature against Google's published keys and that it was issued for `FIREBASE_PROJECT_ID`.
- `GET /api/auth/me` returns the signed-in admin: 401 with no token or a bad one, 403 for a valid sign-in that isn't an admin, 503 if `FIREBASE_PROJECT_ID` isn't set.
- Admins are added by email from the command line. The person becomes an admin the first time they sign in with that email, as long as Firebase reports it verified. After that, their Firebase account is what identifies them.

```sh
docker compose run --rm api python -m swayambhu_api.manage_admins add you@example.org
docker compose run --rm api python -m swayambhu_api.manage_admins list
docker compose run --rm api python -m swayambhu_api.manage_admins remove you@example.org
```

On CloudApps: `oc exec deploy/api -- python -m swayambhu_api.manage_admins ...`.

In the web app, the footer links to `/signin` (Google in a popup, or email and password). Firebase is only downloaded by browsers that open the sign-in page or were signed in before, so public visitors never load it. The web app asks `GET /api/auth/me` whether to show the admin pages; that is only for the UI, since the API checks the token on every admin request.

## Uploading recordings

Admins upload with the [tus](https://tus.io) resumable-upload protocol at `/api/uploads` (served by `tuspyserver`; the web app uses `tus-js-client`). A dropped connection resumes from the last byte the server has. Every route needs an admin token.

In the web app this is **Upload & review** (`/admin`): pick or drop one or more files, or a whole folder. Each recording gets a row with a title taken from its file name and optional details; "Same details for all recordings" fills what the rows leave empty. The files upload one at a time, each with its own progress, Retry after a failure, and Stop for the batch. Uploading the same file again with the same details resumes rather than restarting. The page compares the batch with the space left (`GET /api/storage`), and the API refuses an upload that would leave less than `UPLOAD_FREE_SPACE_MARGIN_BYTES` free. The same page lists interviews in tabs by what to do next (needs attention, processing, not published, published). Each interview's page (`/admin/interviews/{id}`) shows its next step, processing steps and plain-language errors with a Retry button, its details, the transcript editor, and Publish or Unpublish.

The protocol, for scripts:

1. `POST /api/uploads` with `Upload-Length` and `Upload-Metadata`, and no body. Metadata keys: `title`, `filename`, `filetype` (required); `language` (`en`, `ne`, `new`), `interviewee_id` or `interviewee_name`, `recorded_on` (`YYYY`, `YYYY-MM` or `YYYY-MM-DD`) (optional). Bad metadata, and a file too big for the space left (507), are refused here, before any bytes are sent.
2. `PATCH` the returned `Location` in chunks of at most `UPLOAD_CHUNK_MAX_BYTES`. `HEAD` on it tells you where to resume.
3. The last PATCH's response has the new interview's id in `Upload-Interview-Id`. The interview is Private and its processing is already queued.

With the Python client `tuspy`, which resumes and chunks for you:

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

Unfinished uploads sit in `<MEDIA_ROOT>/uploads`; the worker deletes them after `UPLOAD_RETENTION_DAYS` without a new chunk. For bulk loads on the server itself, `python -m swayambhu_worker.ingest FILE --title ...` skips HTTP entirely.

## Processing: transcription, translation, embeddings

All media work runs in the worker, never in a request. Providers sit behind small interfaces in `packages/providers` and are chosen by settings, so swapping one is a config change.

Jobs wait in a Postgres table (`packages/core/.../jobs.py`). Among due jobs the worker takes the highest priority first, then the oldest: an admin's action (an edit, a retry, a re-run), then the next step of an interview already being processed, then a new recording's first steps and bulk re-indexing. So an admin never waits behind a batch of uploads, and a batch finishes one interview at a time.

**Transcription** (`TRANSCRIPTION_PROVIDER`, `TRANSCRIPTION_MODEL`):

The worker cuts the recording into 5 to 20 second pieces at quiet moments and sends `TRANSCRIPTION_CONCURRENCY` of them to the provider at once (default 4), keeping the results in order. It mostly waits on the provider, so this makes long recordings several times faster without more CPU or memory.

- `openai`: an upload whose language no admin has confirmed is sent with the languages in `TRANSCRIPTION_LANGUAGES`. Admins confirm or change the detected language afterwards.
- `mai`: Microsoft's MAI-Transcribe models through Azure Speech's fast transcription API (`TRANSCRIPTION_MODEL=MAI-Transcribe-2`, plus `AZURE_SPEECH_KEY` and `AZURE_SPEECH_ENDPOINT` from a Speech resource in a region that serves the model). It never sends a language: a set language forces it, and interviews often switch between languages, so the model detects the language of each phrase. On 7 minutes of FLEURS Nepali (2026-11-18) it scored 8.4% CER against gpt-transcribe's 10.6%.
- `elevenlabs` and `fake` (offline, for dev and tests) are also available.
- No provider lists Nepal Bhasa. Model ids, regions and prices change: verify before use.

**Translation** (`TRANSLATION_PROVIDER`): Google NMT, or `fake`. A failed translation doesn't stop indexing.

**Embeddings** (`EMBEDDING_PROVIDER=local`): the API and worker embed on CPU with ONNX Runtime, so search needs no API call.

- The api and worker images bake in `intfloat/multilingual-e5-small` under `/opt/models` at build time (`--build-arg EMBEDDING_MODEL=` leaves it out).
- Set `EMBEDDING_MODEL=intfloat/multilingual-e5-small`, `EMBEDDING_QUERY_PREFIX="query: "`, `EMBEDDING_PASSAGE_PREFIX="passage: "`, and leave `EMBEDDING_DIMENSIONS` empty (the model fixes it at 384).
- Text past `LOCAL_EMBEDDING_MAX_TOKENS` is cut off before embedding; keyword search still covers it.
- Measured on CloudApps (1 CPU, 1 thread): the model takes about 400 MiB, queries about 20 ms, and the worker peaks around 540 MiB at batch size 4, so 768Mi limits fit both api and worker.

**Changing the embedding model** (`EMBEDDING_PROVIDER`, `EMBEDDING_MODEL` or `EMBEDDING_DIMENSIONS`, on both api and worker) means re-indexing, because search only compares vectors from the configured model. Run `python -m swayambhu_worker.reindex` in the worker pod: it queues an index job for every transcribed interview with no vectors from the new model (`--dry-run` lists them first). Until those finish, semantic search can't find those interviews; keyword search still can.

## Editing and publishing

- Publish or hide: `PATCH /api/interviews/{id}` `{"visibility": "public"}`.
- Follow processing: `GET /api/interviews/{id}/jobs`. List by status: `GET /api/interviews?status=processing`.
- Correct a line: `PATCH /api/interviews/{id}/segments/{seq}`. The machine text is kept beside the edit; `GET /api/interviews/{id}/transcript` shows both.
- Editing an original line's words makes its English out of date. A `retranslate` job refreshes those lines in one batch `RETRANSLATE_DELAY_SECONDS` after the last edit, or at once with `POST /api/interviews/{id}/retranslate`. Spacing and punctuation alone don't count, and an admin's English edit is never overwritten; it is flagged for checking instead.

## Search

`GET /api/search?q=...` returns transcript moments, best first. Each has its interview, a start and end time, and an excerpt of about 30 s of transcript lines to seek to.

- **Ranking:** keyword search (Postgres full-text) and semantic search (the query's embedding against stored chunk embeddings) are merged by reciprocal rank fusion. Each moment's `matched_by` says which searches found it. `SEARCH_CANDIDATES`, `SEARCH_RRF_K` and `SEARCH_EXCERPT_MS` tune the ranking and excerpts.
- **No count:** there is no match count, only `has_more`.
- **Interview matches:** the first page also has `interviews`, up to five interviews whose title, description, interviewee, interviewer or location contain the query's words, since such a match has no timestamp.
- **Filters:** `language` (any language heard), `interviewee` (an id, or `unknown`), `recorded_from`/`recorded_to` (`undated=true` also keeps interviews with no date), and `media` (`audio` or `video`). `GET /api/interviews` takes the same filters, so the list can be browsed without a query. `GET /api/search/filters` lists the languages and interviewees a viewer can filter by.
- **Fallback:** the API embeds queries with the same `EMBEDDING_*` settings as the worker. If the provider fails or takes longer than `SEARCH_EMBEDDING_TIMEOUT_SECONDS` (remote providers only), results are keyword-only and the response says `"search_mode": "keyword_only"`.

All of these filter by visibility like every other route.

## Health, logs and request IDs

- `GET /api/health`: the process is up. Doesn't touch the database.
- `GET /api/health/ready`: Postgres is reachable and the `vector` extension is installed; 503 otherwise.

The API writes one JSON object per line to stdout (`LOG_FORMAT=json`), which OpenShift collects; `LOG_FORMAT=text` is easier to read locally.

- Every response carries an `X-Request-ID`: the caller's own if it is a short token of letters, digits, `.`, `_` or `-`, otherwise a new one. Every log line written during that request includes it.
- Each request gets one access line: method, path (no query string), status, duration and client IP. Headers, tokens and search terms are never logged.
- An unhandled error is logged with its stack and returns `500 {"detail": "Internal error", "request_id": "..."}`, so a reported ID leads straight to the trace.

## Database and migrations

The API and worker use SQLAlchemy 2. The ORM models are in `packages/core/src/swayambhu_core/models.py`. There is one connection pool per process and one session per request (`DbSession` in `db.py`). Tables are created and changed only by Alembic migrations in `swayambhu_api/migrations/versions`; `db/init` only enables the `vector` extension, which needs a database superuser.

```sh
cd services/api
uv run python -m swayambhu_api.migrate upgrade head                       # apply migrations
uv run python -m swayambhu_api.migrate revision --autogenerate -m "add x"  # after changing models.py
uv run python -m swayambhu_api.migrate check                              # models and migrations agree
```

- Review every autogenerated migration before committing it.
- The API container runs `upgrade head` on every start (`services/api/start.sh`), locally and on CloudApps, so a deploy needs no manual migration step. Pods starting together take turns through a Postgres advisory lock. `RUN_MIGRATIONS=0` skips it.
- On CloudApps the API uses the `Recreate` strategy. If a migration fails, the container exits and the API is down until you redeploy the previous image (`oc rollout undo deploy/api`) or fix the migration.
- Migrations are forward-only unless a downgrade is written, so rolling back the image doesn't undo one that already ran. Take a database backup first (see the deploy guide). Prefer migrations the previous release can still run against (add columns before using them, drop them a release later).
- A database created earlier from `db/init/002_admins.sql` is adopted by the first migration without changes.

Integration tests wipe tables and roll migrations back and forth, so they refuse to run unless the database name ends in `_test`:

```sh
createdb swayambhu_test && psql swayambhu_test -f db/init/001_extensions.sql
DATABASE_URL=postgresql://swayambhu@localhost:5432/swayambhu_test uv run pytest -m integration
```

## Web and API hardening

- Every image runs as a non-root, arbitrary UID. The web and API images listen on 8080; the worker has no HTTP listener. The web app and API share one hostname, with `/api` routed to the API.
- Keys and passwords live in OpenShift Secrets, never in this repository. Only the Firebase web config is public.
- **Web:** nginx sends a Content-Security-Policy, `nosniff`, Referrer-Policy, HSTS and Permissions-Policy on every response (`apps/web/security-headers.inc`). Hashed files under `/assets/` are cached for a year, and `index.html` is revalidated on every load. A new external host (Firebase sign-in, the media store) has to be added to the CSP, or the browser blocks it.
- **API behind the router:** uvicorn takes the client IP from `X-Forwarded-For` only when the request comes from an address in `FORWARDED_ALLOW_IPS`. The API image sets it to `*`, because only the OpenShift router can reach the pod. Override it on the Deployment if the API is ever exposed another way.
- **Base images** are updated by Dependabot. Python and nginx minor versions and Postgres major versions are moved by hand.
