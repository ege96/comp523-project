// Browser smoke tests (Proposal: Playwright). They need the API and worker running with
// fake providers and the e2e overrides; see README.md here.
import { defineConfig, devices } from "@playwright/test";

const WEB_PORT = 5174;
const CI = Boolean(process.env.CI);

export default defineConfig({
  testDir: ".",
  globalSetup: "./global-setup.ts",
  // Tests only read the shared seed, apart from one correction no other test depends on;
  // a test that changes more makes its own interview. So they can run side by side.
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  outputDir: "test-results",
  reporter: CI
    ? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]]
    : "list",
  use: {
    baseURL: `http://localhost:${String(WEB_PORT)}`,
    trace: CI ? "on-first-retry" : "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // The dev server proxies /api to the API on :8000 (vite.config.ts).
    command: `npx vite --port ${String(WEB_PORT)} --strictPort`,
    cwd: "..",
    url: `http://localhost:${String(WEB_PORT)}`,
    reuseExistingServer: !CI,
    env: { VITE_FIREBASE_API_KEY: "e2e-fake-key", VITE_FIREBASE_PROJECT_ID: "comp523-e2e" },
  },
});
