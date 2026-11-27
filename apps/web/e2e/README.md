# Browser smoke tests

Playwright tests (Proposal: Playwright, because it drives a real Chromium, waits for the page
by itself, and runs headless in CI with one command) that click through the real app.

`public.spec.ts`, as a signed-out visitor:

- search from the home page and open a moment at its time;
- play a recording and seek from a transcript line;
- reach Interviews, About and the not-found page from the main navigation;
- never reach a Private interview: not on its page, the interview list or search, and not
  through the API (detail, segments, list, search).

`admin.spec.ts`, as an admin signed in through the sign-in form:

- each interview shows under one tab (Not published or Published); correcting a line of a
  published transcript shows to visitors, marked "Corrected";
- a recording uploaded through the upload form is followed live until it is finished, then
  published (a visitor can open it), unpublished, and deleted with the typed confirmation (a
  visitor then gets "doesn't exist").

They run against the API and worker with the fake AI providers, so they need no keys.
`global-setup.ts` invites a test admin, uploads one Public and one Private generated recording
through the tus API, and waits until the worker has finished them. The tests only read those
two, apart from one transcript correction no other test depends on; the upload test makes and
deletes its own interview. So the tests run in parallel, and every title is unique per run.

Locators are by role and accessible name (`getByRole`, `getByLabel`), the way a person or a
screen reader finds things, and assertions wait for the page (`expect(...).toBeVisible()`,
`expect.poll`) rather than sleeping. `fixtures.ts` has the shared `seed` and `adminPage`.

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
A failed test keeps a trace in `e2e/test-results/` (`npx playwright show-trace <trace.zip>`).

To use an API and worker you run yourself with uv instead of compose, serve `e2e/.auth/jwks`
over HTTP, set `FIREBASE_JWKS_URL` and `FIREBASE_PROJECT_ID=comp523-e2e` for the API, fake
providers for both, and `E2E_API_EXEC="uv run --directory ../../services/api"` so setup can
invite the admin.

CI runs them in the optional `E2E` workflow, which is not a required check.
