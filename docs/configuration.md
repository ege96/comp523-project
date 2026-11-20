# Configuration

Every setting is an environment variable. Locally, the API and worker also read `.env` in their own folder (copy `.env.example`). On CloudApps, plain settings live in the `app-settings` ConfigMap or on the Deployment, and secrets in the `ai-providers` and `db-credentials` Secrets (see [deploy-cloudapps.md](deploy-cloudapps.md)). An empty value counts as unset.

Model names, prices and limits are time-sensitive: verify them before use.

## Shared by the API and worker

The API and worker must use the same embedding settings, or search won't find the worker's stored vectors.

| Variable | Default | Secret | What it does |
|---|---|---|---|
| `DATABASE_URL` | `postgresql://swayambhu@localhost:5432/swayambhu` | yes | libpq connection string |
| `MEDIA_ROOT` | `/data/media` | | Absolute folder for recordings; the same folder for both services |
| `UPLOAD_RETENTION_DAYS` | `3` | | Unfinished uploads untouched this long are deleted (the worker deletes; keep both the same) |
| `TRANSCRIPTION_PROVIDER` | `openai` | | `openai`, `elevenlabs`, `mai` or `fake` |
| `TRANSCRIPTION_MODEL` | none | | Provider's model id, e.g. `gpt-transcribe` or `MAI-Transcribe-2`. Required unless `fake` |
| `TRANSCRIPTION_LANGUAGES` | `ne,en` | | `openai` only: languages to expect when no admin confirmed one |
| `TRANSCRIPTION_CONCURRENCY` | 8 | | Worker: pieces of one recording sent to the transcription provider at once (1 to 16). 8 fits every provider's published limit, including ElevenLabs Free (8 concurrent); verify before raising |
| `TRANSLATION_PROVIDER` | `google_nmt` | | `google_nmt` or `fake` |
| `EMBEDDING_PROVIDER` | `openai` | | `openai`, `local` or `fake` (deployments use `local`) |
| `EMBEDDING_MODEL` | none | | e.g. `intfloat/multilingual-e5-small` (local) or `text-embedding-3-large`. Required unless `fake` |
| `EMBEDDING_DIMENSIONS` | none | | Optional for `openai`; must be empty for `local` |
| `EMBEDDING_MODEL_REVISION` | none | | `local` only: model revision, part of the stored embedding identity |
| `EMBEDDING_QUERY_PREFIX` / `EMBEDDING_PASSAGE_PREFIX` | empty | | Prepended to queries and stored passages (`"query: "`, `"passage: "` for multilingual-e5) |
| `LOCAL_MODEL_DIR` | `/opt/models` | | `local` only: holds `<EMBEDDING_MODEL>/model.onnx` and `tokenizer.json` |
| `LOCAL_EMBEDDING_MAX_TOKENS` | `512` | | Text past this is cut off before embedding |
| `LOCAL_EMBEDDING_THREADS` | `4` | | Should match the pod's CPU limit (`1` on CloudApps) |
| `LOCAL_EMBEDDING_BATCH_SIZE` | `4` | | Keeps the worker's peak near 540 MiB |
| `PROVIDER_TIMEOUT_SECONDS` | `120` | | Timeout for each provider HTTP call |
| `OPENAI_API_KEY` | none | yes | For `openai` transcription or embeddings |
| `ELEVENLABS_API_KEY` | none | yes | For `elevenlabs` transcription |
| `AZURE_SPEECH_KEY` | none | yes | For `mai` transcription |
| `AZURE_SPEECH_ENDPOINT` | none | | For `mai`: the Speech resource's endpoint, in a region that serves the model |
| `GOOGLE_TRANSLATE_API_KEY` | none | yes | For `google_nmt` translation |

## API only

| Variable | Default | Secret | What it does |
|---|---|---|---|
| `FIREBASE_PROJECT_ID` | none | | Firebase project whose sign-ins are accepted. Unset: admin requests get 503. Must match the web's `VITE_FIREBASE_PROJECT_ID` |
| `MEDIA_URL_SECRET` | random per process | yes | Signs expiring media links. Set the same value on every API pod |
| `MEDIA_URL_TTL_SECONDS` | `21600` (6 h) | | How long a media link works |
| `MAX_UPLOAD_BYTES` | 10 GiB | | Largest upload; keep it below the media volume's free space |
| `UPLOAD_CHUNK_MAX_BYTES` | 64 MiB | | Largest single tus PATCH |
| `UPLOAD_FREE_SPACE_MARGIN_BYTES` | 1 GiB | | Space an upload must leave free on the media volume (room for playback copies); larger uploads are refused |
| `RETRANSLATE_DELAY_SECONDS` | `300` | | Wait after the last edit before re-translating edited lines |
| `SEARCH_EMBEDDING_TIMEOUT_SECONDS` | `5` | | How long search waits to embed the query before going keyword-only (remote providers) |
| `SEARCH_CANDIDATES` | `100` | | Hits taken from each of keyword and semantic search; also the deepest page |
| `SEARCH_RRF_K` | `60` | | Rank fusion constant; larger flattens the gap between ranks |
| `SEARCH_EXCERPT_MS` | `30000` | | Roughly how much transcript an excerpt shows |
| `LOG_FORMAT` | `json` | | `json` for OpenShift, `text` locally |
| `LOG_LEVEL` | `INFO` | | Log level |
| `DB_CONNECT_TIMEOUT_SECONDS` | `3` | | Database connect timeout |
| `RUN_MIGRATIONS` | `1` | | `0` skips `upgrade head` on container start |
| `FORWARDED_ALLOW_IPS` | `*` (image) | | Addresses trusted for `X-Forwarded-For` |

## Worker only

| Variable | Default | What it does |
|---|---|---|
| `POLL_INTERVAL_SECONDS` | `5` | How often an idle worker checks for jobs |
| `JOB_LEASE_SECONDS` | `600` | A running job with no heartbeat this long is taken over by another worker |
| `MEDIA_TIMEOUT_SECONDS` | `14400` (4 h) | Longest one FFmpeg or FFprobe run before it's stopped and retried |

## Web build

Read by Vite at build time from `apps/web/.env.production` (committed, public) or `.env.local` for `npm run dev`: `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_AUTH_DOMAIN` and `VITE_API_BASE_URL` (see `apps/web/.env.example`). Changing the Firebase project also means updating the CSP in `apps/web/security-headers.inc` (see [deploy-cloudapps.md](deploy-cloudapps.md)).
