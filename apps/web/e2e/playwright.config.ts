// Browser smoke tests (Proposal: Playwright). They need the API and worker running with
// fake providers and the e2e overrides; see README.md here.
import { defineConfig, devices } from "@playwright/test";

const WEB_PORT = 5174;

export default defineConfig({
  testDir: ".",
  globalSetup: "./global-setup.ts",
  // Tests share one seeded database; the admin test edits a line the others don't read.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${String(WEB_PORT)}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // The dev server proxies /api to the API on :8000 (vite.config.ts).
    command: `npx vite --port ${String(WEB_PORT)} --strictPort`,
    cwd: "..",
    url: `http://localhost:${String(WEB_PORT)}`,
    reuseExistingServer: !process.env.CI,
    env: { VITE_FIREBASE_API_KEY: "e2e-fake-key", VITE_FIREBASE_PROJECT_ID: "comp523-e2e" },
  },
});
