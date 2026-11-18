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

- **The `oc` tool**, logged in as above, and a copy of this repository.
- **A CloudApps project.** The default UNC quota we built for is 4 CPU and 2,560 MiB of memory for all long-running pods together, at most 2 CPU and 2 GiB per container, and 5 GiB of volume storage. The four pods above use 2,176 MiB. Containers with no limit get 300Mi by default, which is too small for `api` and `worker`, so every Deployment in the templates sets its own limits. Check yours with `oc describe quota` and `oc describe limitrange`.
- **Storage for recordings.** Each hour of video takes roughly 1–2 GB (the original plus a 720p streaming copy); audio about 0.1 GB. Ask ITS for more volume storage if you need more than about 4 GB.
- **GitHub access** to the repository, with a fine-grained token that can read its contents.
- **A Firebase project** with the Email/Password and Google sign-in methods turned on.
- **API keys:** OpenAI (transcription) and Google Cloud Translation. Set a monthly spending limit on both accounts.

## 3. First-time setup

Everything that runs is described by two OpenShift templates in `deploy/cloudapps/`:

| File | What it creates | How often |
|---|---|---|
| `setup.yaml` | The Secrets (database password, API keys, GitHub token, build webhook secrets) and the two volumes (`db-data`, `media`) | Once. Re-creating it would replace the generated database password. |
| `app.yaml` | The builds, the four Deployments with their limits, the Services, the routes on one hostname, and the shared settings (`app-settings` ConfigMap) | Every time something in it changes. Safe to re-run. |

Run the commands below from the repository's top folder. They work the same in PowerShell and in a Unix shell.

### 3.1 Fill in the parameters

Copy the two example files and fill them in. The copies are git-ignored; never commit them.

```sh
cp deploy/cloudapps/secrets.env.example deploy/cloudapps/secrets.env   # PowerShell: Copy-Item
cp deploy/cloudapps/app.env.example deploy/cloudapps/app.env
```

- `secrets.env`: the OpenAI and Google Cloud Translation keys, and the GitHub username and token CloudApps builds the repository with. The database password, the media-link key and the webhook secrets are generated for you.
- `app.env`: the site's hostname (`web-<project>.apps.cloudapps.unc.edu` is free to use in your project) and the OpenAI transcription model id. Check the current model name before setting it (verify before use). The other settings have working defaults, listed in the file.

### 3.2 Create the Secrets and volumes (once)

```sh
oc process -f deploy/cloudapps/setup.yaml --param-file=deploy/cloudapps/secrets.env | oc create -f -
```

Then delete `secrets.env`: the values now live only in the project's Secrets. If something already exists, `oc create` says `AlreadyExists` and leaves it as it is. The two volumes take 5 GiB together (1 GiB database, 4 GiB recordings), which is the whole default quota; `DB_VOLUME_SIZE` and `MEDIA_VOLUME_SIZE` in `secrets.env` change that.

### 3.3 Deploy everything

```sh
oc process -f deploy/cloudapps/app.yaml --param-file=deploy/cloudapps/app.env | oc apply -f -
```

This is the one command. The first time, it also starts a build of `api`, `worker` and `web` from `main`. The `api` and `worker` builds include the search model and take several minutes; follow them with `oc get builds -w` or under **Builds** in the console. Each finished build rolls out by itself. The database uses the `pgvector/pgvector:pg16` image (CloudApps' own PostgreSQL template has no pgvector), and the API creates the tables and turns on pgvector when it first starts.

When `oc get pods` shows `api`, `worker`, `web` and `db` Running, `https://<web hostname>/api/health/ready` should return `{"status":"ok","database":true,"pgvector":true}`.

Run the same command again after changing `app.env` or `app.yaml`; it changes only what differs. Pods read the shared settings when they start, so after changing a setting also run `oc rollout restart deploy/api deploy/worker`.

*(Optional, verify)* For a click-only first install, `oc create -f deploy/cloudapps/app.yaml` adds the template to the project's catalog: **+Add**, then **All services**, find **swayambhu**, fill in the form and click **Create**. Do later changes with the command above.

### 3.4 Firebase

The website's Firebase settings are public and live in `apps/web/.env.production`. For a different Firebase project, change the values there (they are build settings, not secrets) and set `FIREBASE_PROJECT_ID` in `app.env` to match. Also update the Content-Security-Policy in `apps/web/security-headers.inc`: the `frame-src` host (the project's auth domain, `<project>.firebaseapp.com`) and, if they change, the Firebase hosts in `connect-src`. The build config and the CSP must name the same project, or the browser blocks the sign-in frame. Rebuild `web`, then test sign-in in a private window. In the Firebase console:

1. **Authentication**, then **Sign-in method**: turn on Email/Password and Google.
2. **Authentication**, then **Settings**, then **Authorized domains**: add the web hostname.
3. In the Google Cloud console for the same project, restrict the browser API key to the web hostname (Websites) and to the Identity Toolkit and Token Service APIs.

### 3.5 Rebuild automatically when `main` changes

The workflow `.github/workflows/cloudapps-build.yml` rebuilds only the apps whose files changed, by calling each build's Generic webhook. For each of `api`, `web` and `worker`: **Builds**, then **BuildConfigs**, the app, **Details**, and under **Webhooks**, **Generic**, click **Copy URL with Secret**. On GitHub, add the three URLs as repository secrets (**Settings**, then **Secrets and variables**, then **Actions**) named `OPENSHIFT_WEBHOOK_API`, `OPENSHIFT_WEBHOOK_WEB` and `OPENSHIFT_WEBHOOK_WORKER`. **Actions**, then **CloudApps build**, then **Run workflow** rebuilds all three by hand. To build by hand from the command line instead: `oc start-build <app>`.

### 3.6 First admin, and a test

```sh
oc exec deploy/api -- python -m swayambhu_api.manage_admins add <email>
```

Then check, in this order:

- [ ] `https://<web hostname>/api/health/ready` says the database and pgvector are ready.
- [ ] **Admin sign-in** at the bottom of the site works with that email.
- [ ] A short test upload finishes processing (Done) and plays.
- [ ] After **Publish**, it appears in search from a private browser window. After **Unpublish**, it doesn't.

### 3.7 Moving a project that was set up by hand

Projects set up before these templates (with the console's Import from Git) can switch to them in place: the templates use the same Deployment, Service, route and Secret names (`media`, `db-credentials`, `ai-providers`, and `<app>-generic-webhook-secret` for the build webhooks, so the URLs in the GitHub secrets keep working). Skip §3.2, since the Secrets and volumes already exist. Before applying, look at what would change; neither command changes anything:

```sh
oc process -f deploy/cloudapps/app.yaml --param-file=deploy/cloudapps/app.env | oc diff -f -
oc process -f deploy/cloudapps/app.yaml --param-file=deploy/cloudapps/app.env | oc apply --dry-run=server -f -
```

- **Names that differ from the templates' defaults.** Projects made by hand may have used other names. Set them in `app.env`: `DB_VOLUME_CLAIM` for the database volume and `GIT_SOURCE_SECRET` for the GitHub token Secret. Find them with `oc get pvc` and `oc get bc/api -o jsonpath='{.spec.source.sourceSecret.name}'`.
- **Check the database is on its volume** before anything else: `oc get deploy/db -o jsonpath='{.spec.template.spec.volumes}'`. If it shows `emptyDir`, the database lives only inside the pod and is wiped whenever the pod restarts. Applying the template moves it onto `DB_VOLUME_CLAIM`, which starts a database from whatever is on that volume. So first take a dump (§5 step 2), apply, then restore the dump into the new database (§5 restore step 3).
- **Selectors.** The templates select pods by `app=<name>`, as the console's Import from Git does. If the dry run says a Deployment's `spec.selector` is immutable, delete just that Deployment (`oc delete deploy/<name>`) and apply again. Its volume and Secrets stay.
- **A port listed twice.** Import from Git can list the container port twice, which `oc apply` may refuse to merge. Remove the copy first: `oc patch deploy/web --type=json -p '[{"op":"remove","path":"/spec/template/spec/containers/0/ports/1"}]'`.
- **Settings set earlier with `oc set env`** stay on the Deployments and take precedence over `app-settings`. List them with `oc set env deploy/api --list`, and remove any you now set in `app.env` with `oc set env deploy/api <NAME>-`.
- **GitHub-type build webhooks.** The templates keep only the Generic webhook that the workflow in §3.5 calls (same Secret names as the console's, so its URLs don't change). Applying removes the GitHub-type trigger; delete any OpenShift webhooks left under the repository's **Settings**, then **Webhooks**.

## 4. Day-to-day jobs

**Add or remove an admin.** People become admins the first time they sign in with an added email (the email must be verified by Firebase, which Google accounts always are).

```sh
oc exec deploy/api -- python -m swayambhu_api.manage_admins add <email>
oc exec deploy/api -- python -m swayambhu_api.manage_admins list
oc exec deploy/api -- python -m swayambhu_api.manage_admins remove <email>
```

**Change an API key.** Edit the Secret, then restart everything that reads it. Don't set the key directly on a Deployment: that overrides the Secret and leaves it stale.

```sh
oc edit secret/ai-providers    # values under stringData, or base64 under data
oc rollout restart deployment/api deployment/worker
```

Changing `MEDIA_URL_SECRET` only makes open media links stop working until the page is reloaded.

**Restart.** `oc rollout restart deploy/<name>`. Processing that was interrupted is picked up again by the worker.

**Logs.** `oc logs deploy/api` (one JSON line per request; an unexpected error's response carries a `request_id`, which leads to its log line) and `oc logs deploy/worker`.

**Disk space.** `oc exec deploy/api -- df -h /data/media`. Uploads fail when the media volume is full, so keep `MAX_UPLOAD_BYTES` (default 10 GiB) below its free space.

**Roll back a bad deploy.** `oc rollout undo deploy/<name>` redeploys the previous image. `api` uses the `Recreate` strategy, so the old pod is stopped before the new one starts. The API runs database migrations on start; if one fails, the new pod exits and never becomes ready, and the site's API is down until you roll back or fix it. Migrations only go forward: rolling back the image does not undo a migration that already succeeded, and the previous release may not run against the new schema unless the change was written to allow it. If it can't, restore the database from the paired backup taken before the deploy (§5). Take a backup pair before any deploy that includes a migration.

**Change a setting** (transcription model or languages, Firebase project, branch). Edit `app.env`, re-run the deploy command (§3.3), then `oc rollout restart deploy/api deploy/worker`. Settings `api` and `worker` share live in one ConfigMap, `app-settings`, so the two can't drift apart.

**Change the search model.** Change `EMBEDDING_MODEL` as above (the images must include the model; see the README), then run `oc exec deploy/worker -- python -m swayambhu_worker.reindex` (add `--dry-run` first to see what it would do). Keyword search keeps working while it runs.

## 5. Backups and restore

Back up two things: the database (details, transcripts, corrections, admins) and the media volume (recordings). The search index is rebuilt from the transcripts, so a database backup covers it.

A restorable backup is a **pair**: one database dump and one copy of the media volume, taken together and labeled with the same date, e.g. `2026-11-11`. Keep the two together. A database dump that references recordings missing from the media copy restores into an archive with broken interviews.

Take a pair like this, so the media copy includes everything the dump references:

1. Stop processing and uploads: tell admins not to upload, then `oc scale deploy/worker --replicas=0` and wait for its pod to disappear (`oc get pods`).
2. Dump the database first. The file is kept off CloudApps (for example on department storage):

   ```sh
   oc exec deploy/db -- pg_dump -U swayambhu -d swayambhu -Fc > swayambhu-$(date +%F).dump
   ```

3. Then copy the recordings: each interview's folder, the original and its streaming copy. Because the dump came first, the copy holds at least everything the dump references. *(verify: `oc rsync` needs `tar` or `rsync` in the container)*

   ```sh
   oc rsync $(oc get pods -o name | grep '^pod/api-' | head -1):/data/media/interviews ./media-backup-$(date +%F)/
   ```

4. Scale the worker back up: `oc scale deploy/worker --replicas=1`.

Do this daily or before any big change, and always before a deploy that includes a migration. Label both with the same date and keep them together.

**Restore** replaces live data, so rehearse it in a spare environment (a spare project, or a scratch database) before you need it. Use one matching pair.

1. Copy the recordings from the pair's media copy back first. This only adds files, so it is safe while the site is running:

   ```sh
   oc rsync ./media-backup-<date>/interviews $(oc get pods -o name | grep '^pod/api-' | head -1):/data/media/
   ```

2. Stop everything that writes, and wait until the pods are gone. Scaling is asynchronous, and the worker only stops between jobs.

   ```sh
   oc scale deploy/api --replicas=0
   oc scale deploy/worker --replicas=0
   oc wait --for=delete pod -l app=api --timeout=300s
   oc wait --for=delete pod -l app=worker --timeout=300s
   ```

   (Check the labels with `oc get pods --show-labels` and use the ones your pods carry. Don't continue until no `api-` or `worker-` pod is listed.)

3. Restore the database. Prefer restoring into a fresh, empty database first (for example `swayambhu_restore`, with `CREATE EXTENSION vector`), checking it there, and only then restoring into the live one. `--single-transaction` makes the restore all-or-nothing and `--exit-on-error` stops at the first error, so a failed restore leaves the database as it was:

   ```sh
   oc exec -i deploy/db -- pg_restore -U swayambhu -d swayambhu --clean --if-exists \
     --single-transaction --exit-on-error < <file>.dump
   ```

   If it prints any error, stop. Don't scale anything back up until you know why.

4. Verify before reopening: every recording the database references must exist on the volume. Start `api` (`oc scale deploy/api --replicas=1`) with its route not yet announced to users, then:

   ```sh
   oc exec deploy/db -- psql -U swayambhu -d swayambhu -Atc "SELECT storage_key FROM media_files" > keys.txt
   oc exec -i deploy/api -- sh -c 'cd /data/media && while read -r k; do [ -e "$k" ] || echo "MISSING $k"; done' < keys.txt
   ```

   No `MISSING` lines should appear. Also open one restored interview and play it. If any file is missing, the pair doesn't match: stop and use a different pair.

5. Only after that, scale the worker back up (`oc scale deploy/worker --replicas=1`) and check `https://<web hostname>/api/health/ready`.

## 6. Troubleshooting

| Symptom | Likely cause | What to do |
|---|---|---|
| Pod restarts with `OOMKilled` | Memory limit too low or missing | Check the limits in `deploy/cloudapps/app.yaml`; `oc describe pod <pod>` shows the limit in use |
| `api` never becomes ready | Database down, or a migration failed | `oc logs deploy/api`; check `db` is Running |
| An interview stays Processing | Worker stopped or out of memory | `oc logs deploy/worker`; `oc rollout restart deploy/worker` |
| An interview says Failed | A provider refused or timed out | The admin page shows a plain message; check the key and spending limit, then press Retry |
| English is missing for Nepal Bhasa | Google doesn't translate it reliably | Expected; the original stays searchable and editable |
| Sign-in says "not an admin" | Email not added | `manage_admins add <email>` |
| Sign-in popup fails | Hostname not in Firebase's authorized domains | §3.4 step 2 |
| Pods stuck in `ImagePullBackOff` right after the first deploy | The first builds haven't finished | Wait for `oc get builds` to show Complete; they roll out by themselves |
| `oc create` or `oc apply` says `exceeded quota` | The project's quota is smaller than the defaults | `oc describe quota`; lower the volume sizes in `secrets.env`, or ask ITS for more |
| Uploads fail near the end | Media volume full | Check disk space (§4); ask ITS for more storage |
