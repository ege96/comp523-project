// Seeds the running stack once per run: an admin invite, then one Public and one Private
// recording uploaded through the real tus API and processed by the worker's fake providers.
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

import { ADMIN, AUTH_DIR, ensureKeys, idToken } from "./support/auth";
import { API_URL, type Seed } from "./support/seed";

// How to run a command in the API's environment. The default is the compose stack;
// set E2E_API_EXEC="uv run --directory ../../services/api" to run against a local API.
const API_EXEC =
  process.env.E2E_API_EXEC ??
  "docker compose -f ../../compose.yaml -f ../../compose.e2e.yaml exec -T api";

/** A mono 16 kHz WAV: 8 s tone, 2 s silence, repeated, so the worker cuts several lines. */
function toneWav(seconds: number): Buffer {
  const rate = 16_000;
  const samples = seconds * rate;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    const loud = (i / rate) % 10 < 8;
    buf.writeInt16LE(
      loud ? Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate)) : 0,
      44 + i * 2,
    );
  }
  return buf;
}

async function api(
  method: string,
  url: string,
  { headers = {}, body }: { headers?: Record<string, string>; body?: BodyInit } = {},
): Promise<Response> {
  const res = await fetch(`${API_URL}${url}`, {
    method,
    body,
    headers: { Authorization: `Bearer ${idToken()}`, ...headers },
  });
  if (!res.ok) throw new Error(`${method} ${url}: HTTP ${String(res.status)} ${await res.text()}`);
  return res;
}

/** The tus protocol by hand: one POST to create, one PATCH with the whole (small) file. */
async function upload(title: string, file: Buffer): Promise<string> {
  const meta = { filename: "e2e-tone.wav", filetype: "audio/wav", title, language: "ne" };
  const tus = { "Tus-Resumable": "1.0.0" };
  const created = await api("POST", "/api/uploads", {
    headers: {
      ...tus,
      "Upload-Length": String(file.length),
      "Upload-Metadata": Object.entries(meta)
        .map(([k, v]) => `${k} ${Buffer.from(v).toString("base64")}`)
        .join(","),
    },
  });
  const location = new URL(created.headers.get("Location") ?? "", API_URL).pathname;
  const sent = await api("PATCH", location, {
    headers: { ...tus, "Upload-Offset": "0", "Content-Type": "application/offset+octet-stream" },
    body: new Uint8Array(file),
  });
  const id = sent.headers.get("Upload-Interview-Id");
  if (!id) throw new Error("Upload finished without an interview id");
  return id;
}

async function waitUntilDone(id: string): Promise<void> {
  for (let i = 0; i < 120; i++) {
    const res = await api("GET", `/api/interviews/${id}`);
    const { status, status_detail } = (await res.json()) as {
      status: string;
      status_detail?: string;
    };
    if (status === "done") return;
    if (status === "failed") throw new Error(`Interview ${id} failed: ${String(status_detail)}`);
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
  const seed: Seed = {
    publicTitle: `E2E public recording ${run}`,
    privateTitle: `E2E private recording ${run}`,
    publicId: "",
    privateId: "",
  };
  seed.publicId = await upload(seed.publicTitle, wav);
  seed.privateId = await upload(seed.privateTitle, wav);
  await Promise.all([waitUntilDone(seed.publicId), waitUntilDone(seed.privateId)]);
  await api("PATCH", `/api/interviews/${seed.publicId}`, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ visibility: "public" }),
  });
  writeFileSync(path.join(AUTH_DIR, "seed.json"), JSON.stringify(seed));
}
