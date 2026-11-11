# Deploying and running the archive on CloudApps

This guide sets up the whole archive in a Carolina CloudApps (OpenShift) project, and covers the jobs that come up after that: adding admins, changing keys, redeploying, and backups. It's for whoever looks after the system (the "operator"). You don't need to know OpenShift, Docker or PostgreSQL, but you'll type a few commands.

Commands use the `oc` command-line tool. Download it from the **?** menu, then **Command line tools**, in the CloudApps console (`https://console.apps.cloudapps.unc.edu`). Log in with **Copy login command** from your name's menu in the console, then select your project:

```sh
oc login --token=<token> --server=<server>   # pasted from "Copy login command"
oc project <your-project>
```

Values in `<angle brackets>` are yours to fill in. Steps marked *(verify)* haven't been repeated since CloudApps last changed.

## 1. What runs where

| Piece | OpenShift name | Public? | Memory limit |
|---|---|---|---|
| Website (nginx serving the React app) | `web` | Yes, at `/` | 128Mi |
| API (FastAPI): search, sign-in checks, uploads, media links | `api` | Yes, at `/api` on the same hostname | 768Mi |
| Worker: playback copies, transcription, translation, search index | `worker` | No | 768Mi |
| PostgreSQL 16 with pgvector | `db` | No | 512Mi |

Recordings live on a shared volume mounted at `/data/media` in both `api` and `worker`. The database has its own volume. Sign-in is Firebase Authentication, transcription is OpenAI, and translation is Google Cloud Translation. Search runs inside `api` and `worker` (`EMBEDDING_PROVIDER=local`), so it calls no outside service.

## 2. What you need first

- **A CloudApps project.** The default UNC quota we built for is 4 CPU and 2,560 MiB of memory for all long-running pods together, at most 2 CPU and 2 GiB per container, and 5 GiB of volume storage. The four pods above use 2,176 MiB. Containers with no limit get 300Mi by default, which is too small for `api` and `worker`, so every Deployment sets its own limits. Check yours with `oc describe quota` and `oc describe limitrange`.
- **Storage for recordings.** Each hour of video takes roughly 1–2 GB (the original plus a 720p streaming copy); audio about 0.1 GB. Ask ITS for more volume storage if you need more than about 4 GB.
- **GitHub access** to the repository, with a fine-grained token that can read its contents (the repository is private).
- **A Firebase project** with the Email/Password and Google sign-in methods turned on.
- **API keys:** OpenAI (transcription) and Google Cloud Translation. Set a monthly spending limit on both accounts.

## 3. First-time setup

### 3.1 Secrets

Keys and passwords go in OpenShift Secrets, never in the repository. Make a database password with `openssl rand -hex 24` (hex, so it's safe inside a URL), then:

```sh
oc create secret generic db-credentials \
  --from-literal=POSTGRES_USER=swayambhu \
  --from-literal=POSTGRES_DB=swayambhu \
  --from-literal=POSTGRES_PASSWORD=<password> \
  --from-literal=DATABASE_URL=postgresql://swayambhu:<password>@db:5432/swayambhu

oc create secret generic ai-providers \
  --from-literal=OPENAI_API_KEY=<openai key> \
  --from-literal=GOOGLE_TRANSLATE_API_KEY=<google key> \
  --from-literal=MEDIA_URL_SECRET=$(openssl rand -hex 32)

oc create secret generic github-read \
  --type=kubernetes.io/basic-auth \
  --from-literal=username=<github username> \
  --from-literal=password=<github token>
```

### 3.2 Database

Use the `pgvector/pgvector:pg16` image, not CloudApps' PostgreSQL template (its versions are too old and have no pgvector).

```sh
oc new-app docker.io/pgvector/pgvector:pg16 --name=db \
  -e PGDATA=/var/lib/postgresql/data/pgdata
oc set env deploy/db --from=secret/db-credentials
oc set resources deploy/db --limits=memory=512Mi --requests=memory=512Mi
oc set volume deploy/db --add --name=data --type=pvc --claim-name=db-data \
  --claim-size=1Gi --claim-mode=ReadWriteOnce --mount-path=/var/lib/postgresql/data
oc patch deploy/db -p '{"spec":{"strategy":{"type":"Recreate","rollingUpdate":null}}}'
```

`Recreate` matters: a rolling update would start a second database on the same volume and hang. When the pod is Running, turn on pgvector once:

```sh
oc exec deploy/db -- psql -U swayambhu -d swayambhu -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

Tables are created by the API on its first start (it runs the database migrations itself).

### 3.3 API, worker and website

Each app is built from the repository by CloudApps. In the console: **+Add**, then **Import from Git**, repository URL `https://github.com/<owner>/comp523-project`, **Show advanced Git options**, Git reference `main`, source secret `github-read`, Import Strategy **Dockerfile**.

| Name | Context dir | Dockerfile path | Target port | Route |
|---|---|---|---|---|
| `api` | `/` | `services/api/Dockerfile` | pick 8080 from the list | Path `/api`, Secure (Edge, Redirect) |
| `worker` | `/` | `services/worker/Dockerfile` | — | Untick "Create a route" |
| `web` | `/apps/web` | `Dockerfile` | pick 8080 from the list | Path empty, Secure (Edge, Redirect) |

Pick the port from the dropdown: typing it can list it twice and fail with `Duplicate value: "8080-tcp"`. The `api` and `worker` builds include the search model, so they take a few minutes.

Then give `api` and `worker` their settings, volume and limits:

```sh
for app in api worker; do
  oc set env deploy/$app --from=secret/db-credentials --from=secret/ai-providers
  oc set env deploy/$app \
    TRANSCRIPTION_PROVIDER=openai TRANSCRIPTION_MODEL=<openai transcription model> \
    TRANSLATION_PROVIDER=google_nmt \
    EMBEDDING_PROVIDER=local EMBEDDING_MODEL=intfloat/multilingual-e5-small \
    EMBEDDING_QUERY_PREFIX="query: " EMBEDDING_PASSAGE_PREFIX="passage: " \
    LOCAL_EMBEDDING_THREADS=1
  oc set resources deploy/$app --limits=cpu=1,memory=768Mi --requests=cpu=250m,memory=768Mi
  oc patch deploy/$app -p '{"spec":{"strategy":{"type":"Recreate","rollingUpdate":null}}}'
done
oc set env deploy/api FIREBASE_PROJECT_ID=<firebase project id>
oc set volume deploy/api --add --name=media --type=pvc --claim-name=media \
  --claim-size=4Gi --claim-mode=ReadWriteMany --mount-path=/data/media
oc set volume deploy/worker --add --name=media --type=pvc --claim-name=media \
  --mount-path=/data/media
oc set resources deploy/web --limits=cpu=300m,memory=128Mi
```

Check the current OpenAI transcription model name before setting it (verify before use). Search compares only vectors made by the same model, so `api` and `worker` must always have the same `EMBEDDING_*` settings.

Health checks for `api` (console: **Actions**, then **Add Health Checks**): readiness `GET /api/health/ready` and liveness `GET /api/health`, both on port 8080.

### 3.4 One hostname for the website and the API

The website calls `/api` on its own hostname. Find the web route's hostname (**Networking**, then **Routes**, e.g. `web-<project>.apps.cloudapps.unc.edu`), then replace the API's route with one on that hostname:

```sh
oc delete route api
oc create route edge api --service=api --port=8080 --hostname=<web hostname> \
  --path=/api --insecure-policy=Redirect
```

`https://<web hostname>/api/health/ready` should now return `{"status":"ok","database":true,"pgvector":true}`.

### 3.5 Firebase

The website's Firebase settings are public and live in `apps/web/.env.production`. For a different Firebase project, change the values there (they are build settings, not secrets). In the Firebase console:

1. **Authentication**, then **Sign-in method**: turn on Email/Password and Google.
2. **Authentication**, then **Settings**, then **Authorized domains**: add the web hostname.
3. In the Google Cloud console for the same project, restrict the browser API key to the web hostname (Websites) and to the Identity Toolkit and Token Service APIs.

### 3.6 Rebuild automatically when `main` changes

The workflow `.github/workflows/cloudapps-build.yml` rebuilds only the apps whose files changed. For each of `api`, `web` and `worker`: **Builds**, then **BuildConfigs**, the app, **Details**, and under **Webhooks**, **Generic**, click **Copy URL with Secret**. On GitHub, add the three URLs as repository secrets (**Settings**, then **Secrets and variables**, then **Actions**) named `OPENSHIFT_WEBHOOK_API`, `OPENSHIFT_WEBHOOK_WEB` and `OPENSHIFT_WEBHOOK_WORKER`. **Actions**, then **CloudApps build**, then **Run workflow** rebuilds all three by hand.

### 3.7 First admin, and a test

```sh
oc exec deploy/api -- python -m swayambhu_api.manage_admins add <email>
```

Then check, in this order:

- [ ] `https://<web hostname>/api/health/ready` says the database and pgvector are ready.
- [ ] **Admin sign-in** at the bottom of the site works with that email.
- [ ] A short test upload finishes processing (Done) and plays.
- [ ] After **Publish**, it appears in search from a private browser window. After **Unpublish**, it doesn't.

## 4. Day-to-day jobs

**Add or remove an admin.** People become admins the first time they sign in with an added email (the email must be verified by Firebase, which Google accounts always are).

```sh
oc exec deploy/api -- python -m swayambhu_api.manage_admins add <email>
oc exec deploy/api -- python -m swayambhu_api.manage_admins list
oc exec deploy/api -- python -m swayambhu_api.manage_admins remove <email>
```

**Change an API key.** `oc set env deploy/api deploy/worker OPENAI_API_KEY=<new key>` (or edit the `ai-providers` Secret and restart both). Changing `MEDIA_URL_SECRET` only makes open media links stop working until the page is reloaded.

**Restart.** `oc rollout restart deploy/<name>`. Processing that was interrupted is picked up again by the worker.

**Logs.** `oc logs deploy/api` (one JSON line per request; an unexpected error's response carries a `request_id`, which leads to its log line) and `oc logs deploy/worker`.

**Disk space.** `oc exec deploy/api -- df -h /data/media`. Uploads fail when the media volume is full, so keep `MAX_UPLOAD_BYTES` (default 10 GiB) below its free space.

**Roll back a bad deploy.** `oc rollout undo deploy/<name>`. The API runs database migrations on start; if one fails, the new pod never becomes ready and the old one keeps serving.

**Change the search model.** Set the same new `EMBEDDING_*` values on both `api` and `worker`, then run `oc exec deploy/worker -- python -m swayambhu_worker.reindex` (add `--dry-run` first to see what it would do). Keyword search keeps working while it runs.

## 5. Backups and restore

Back up two things: the database (details, transcripts, corrections, admins) and the media volume (recordings). The search index is rebuilt from the transcripts, so a database backup covers it.

**Database**, daily or before any big change. The dump is a single file you keep off CloudApps (for example on department storage):

```sh
oc exec deploy/db -- pg_dump -U swayambhu -d swayambhu -Fc > swayambhu-$(date +%F).dump
```

**Recordings**, after each batch of uploads. This copies each interview's folder: the original and its streaming copy. *(verify: `oc rsync` needs `tar` or `rsync` in the container)*

```sh
oc rsync $(oc get pods -o name | grep '^pod/api-' | head -1):/data/media/interviews ./media-backup/
```

**Restore** into a working deployment (§3), with the worker stopped so nothing processes halfway:

```sh
oc scale deploy/worker --replicas=0
oc exec -i deploy/db -- pg_restore -U swayambhu -d swayambhu --clean --if-exists < <file>.dump
oc rsync ./media-backup/interviews $(oc get pods -o name | grep '^pod/api-' | head -1):/data/media/
oc scale deploy/worker --replicas=1
oc rollout restart deploy/api
```

Try a restore into a spare project once, so you know the backups work before you need them.

## 6. Troubleshooting

| Symptom | Likely cause | What to do |
|---|---|---|
| Pod restarts with `OOMKilled` | Memory limit too low or missing | Check §3.3 limits; `oc describe pod <pod>` shows the limit in use |
| `api` never becomes ready | Database down, or a migration failed | `oc logs deploy/api`; check `db` is Running |
| An interview stays Processing | Worker stopped or out of memory | `oc logs deploy/worker`; `oc rollout restart deploy/worker` |
| An interview says Failed | A provider refused or timed out | The admin page shows a plain message; check the key and spending limit, then press Retry |
| English is missing for Nepal Bhasa | Google doesn't translate it reliably | Expected; the original stays searchable and editable |
| Sign-in says "not an admin" | Email not added | `manage_admins add <email>` |
| Sign-in popup fails | Hostname not in Firebase's authorized domains | §3.5 step 2 |
| Uploads fail near the end | Media volume full | Check disk space (§4); ask ITS for more storage |
