import { readFileSync } from "node:fs";
import path from "node:path";

import { AUTH_DIR } from "./auth";

export const API_URL = process.env.E2E_API_URL ?? "http://localhost:8000";

/** What global-setup created for this run. Titles are unique per run. */
export type Seed = {
  publicId: string;
  publicTitle: string;
  privateId: string;
  privateTitle: string;
};

export const seed = (): Seed =>
  JSON.parse(readFileSync(path.join(AUTH_DIR, "seed.json"), "utf8")) as Seed;
