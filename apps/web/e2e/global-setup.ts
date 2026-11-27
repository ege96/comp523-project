// Seeds the running stack once per run: an admin invite, then one Public and one Private
// interview uploaded through the real tus API and processed by the worker's fake providers.
// Tests that change data make their own (admin.spec.ts uploads and deletes one).
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

import { ADMIN, ensureKeys } from "./support/auth";
import { adminApi, API_URL, SEED_FILE, toneWav, type Seed } from "./support/seed";

// How to run a command in the API's environment. The default is the compose stack;
// set E2E_API_EXEC="uv run --directory ../../services/api" to run against a local API.
const API_EXEC =
  process.env.E2E_API_EXEC ??
  "docker compose -f ../../compose.yaml -f ../../compose.e2e.yaml exec -T api";

/** The tus protocol by hand: one POST to create, one PATCH with the whole (small) file. */
async function upload(title: string, file: Buffer): Promise<string> {
  const meta = { filename: "e2e-tone.wav", filetype: "audio/wav", title, language: "ne" };
  const tus = { "Tus-Resumable": "1.0.0" };
  const created = await adminApi("POST", "/api/uploads", {
    headers: {
      ...tus,
      "Upload-Length": String(file.length),
      "Upload-Metadata": Object.entries(meta)
        .map(([k, v]) => `${k} ${Buffer.from(v).toString("base64")}`)
        .join(","),
    },
  });
  const location = new URL(created.headers.get("Location") ?? "", API_URL).pathname;
  const sent = await adminApi("PATCH", location, {
    headers: { ...tus, "Upload-Offset": "0", "Content-Type": "application/offset+octet-stream" },
    body: new Uint8Array(file),
  });
  const id = sent.headers.get("Upload-Interview-Id");
  if (!id) throw new Error("Upload finished without an interview id");
  return id;
}

/** Polls until every processing job (including indexing for search) has finished. */
async function waitUntilDone(id: string): Promise<void> {
  for (let i = 0; i < 120; i++) {
    const interview = (await (await adminApi("GET", `/api/interviews/${id}`)).json()) as {
      status: string;
      status_detail?: string;
    };
    if (interview.status === "failed")
      throw new Error(`Interview ${id} failed: ${String(interview.status_detail)}`);
    if (interview.status === "done") {
      const jobs = (await (await adminApi("GET", `/api/interviews/${id}/jobs`)).json()) as {
        items: { state: string }[];
      };
      if (jobs.items.every((j) => j.state === "done")) return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Interview ${id} was not processed within 2 minutes`);
}

/** The API runs its migrations before it serves, so give a fresh stack a minute. */
async function waitForApi(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const ready = await fetch(`${API_URL}/api/health/ready`).then(
      (r) => r.ok,
      () => false,
    );
    if (ready) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`The API at ${API_URL} is not ready`);
}

export default async function globalSetup(): Promise<void> {
  ensureKeys();
  await waitForApi();
  try {
    execSync(`${API_EXEC} python -m swayambhu_api.manage_admins add ${ADMIN.email}`, {
      stdio: "pipe",
    });
  } catch (e) {
    // Exit 1 means the invite already exists (an earlier run against the same database).
    if ((e as { status?: number }).status !== 1) throw e;
  }
  const run = Date.now().toString(36);
  const wav = toneWav(40);
  const publicTitle = `E2E public recording ${run}`;
  const privateTitle = `E2E private recording ${run}`;
  const [publicId, privateId] = await Promise.all([
    upload(publicTitle, wav),
    upload(privateTitle, wav),
  ]);
  await Promise.all([waitUntilDone(publicId), waitUntilDone(privateId)]);
  await adminApi("PATCH", `/api/interviews/${publicId}`, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ visibility: "public" }),
  });
  const seed: Seed = { publicId, publicTitle, privateId, privateTitle };
  writeFileSync(SEED_FILE, JSON.stringify(seed));
}
