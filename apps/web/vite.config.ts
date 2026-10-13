/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    // In dev, forward API calls to the FastAPI server so the browser sees one origin.
    proxy: { "/api": "http://localhost:8000" },
  },
  test: {
    environment: "jsdom",
  },
});
