# Browser smoke tests

Four Playwright tests (Proposal: Playwright, because it drives a real Chromium, waits for the
page by itself, and runs headless in CI with one command) that click through the real app:

- a visitor searches from the home page and opens a timestamped moment;
- the interview viewer plays the recording and seeks from a transcript line;
- a Private interview is hidden from visitors on every page and API route;
- an admin signs in and corrects a transcript line, and visitors see it marked "Corrected".

They run against the compose stack with the fake AI providers, so they need no keys.
`global-setup.ts` invites a test admin, uploads two short generated recordings through the
tus API, waits for the worker, and makes one Public.

**Sign-in without Firebase.** The tests make their own signing key in `.auth/` (git-ignored).
`compose.e2e.yaml` points the API at its public half (`FIREBASE_PROJECT_ID=comp523-e2e`), and
the browser's calls to Google's sign-in API are answered by `support/auth.ts`. The app code
is unchanged; production still only accepts Google-signed tokens for `comp523`.

## Run

```sh
cd apps/web
mkdir -p e2e/.auth/jwks   # before compose starts, so Docker doesn't make it as root
docker compose -f ../../compose.yaml -f ../../compose.e2e.yaml up -d --build
npx playwright install chromium   # once
npm run e2e
```

`npm run e2e` starts the Vite dev server on port 5174 and expects the API on port 8000.
Every run adds two recordings to the database; `docker compose ... down -v` clears it.

To use an API you run yourself with uv instead of compose, serve `e2e/.auth/jwks` over HTTP,
set `FIREBASE_JWKS_URL` and `FIREBASE_PROJECT_ID=comp523-e2e` for the API, and set
`E2E_API_EXEC="uv run --directory ../../services/api"` so setup can invite the admin.

CI runs them in the optional `E2E` workflow, which is not a required check.
