/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    // In dev, forward API calls to the FastAPI server so the browser sees one origin. The
    // Host header is kept, so absolute URLs the API builds (tus upload Locations) point back
    // at this server rather than straight at :8000, which the browser would block (CORS).
    proxy: { "/api": { target: "http://localhost:8000", changeOrigin: false } },
  },
  test: {
    environment: "jsdom",
    // e2e/ holds the Playwright browser tests (npm run e2e), not Vitest tests.
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/main.tsx",
        "src/**/*.d.ts",
        "src/**/*.test.{ts,tsx}",
        "src/test/**",
        // Generated types, and the thin Firebase SDK adapter (needs a real Firebase project).
        "src/api/schema.gen.ts",
        "src/auth/firebaseClient.ts",
      ],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
