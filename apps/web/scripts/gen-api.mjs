// Regenerates src/api/schema.gen.ts from the FastAPI app's OpenAPI schema (D-009).
// Run `npm run gen:api` after changing an API route or response model. Needs uv.
// Node instead of a shell one-liner so it also works from Windows' cmd.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const apiDir = fileURLToPath(new URL("../../../services/api", import.meta.url));
const schema = execFileSync(
  "uv",
  [
    "run",
    "--frozen",
    "--project",
    apiDir,
    "python",
    "-c",
    "import json; from swayambhu_api.main import app; print(json.dumps(app.openapi()))",
  ],
  { encoding: "utf8" },
);

const dir = mkdtempSync(join(tmpdir(), "openapi-"));
try {
  const file = join(dir, "openapi.json");
  writeFileSync(file, schema);
  // Run on demand rather than installed: it pins TypeScript 5 as a peer, the app uses 6.
  execFileSync("npx", ["--yes", "openapi-typescript@7.13.0", file, "-o", "src/api/schema.gen.ts"], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
