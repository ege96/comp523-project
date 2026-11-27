// What global-setup creates, and the small API client it uses to create it.
import { readFileSync } from "node:fs";
import path from "node:path";

import { AUTH_DIR, idToken } from "./auth";

export const API_URL = process.env.E2E_API_URL ?? "http://localhost:8000";
const SEED_FILE = path.join(AUTH_DIR, "seed.json");

/** One Public and one Private interview, processed by the worker. Titles are unique per run. */
export type Seed = {
  publicId: string;
  publicTitle: string;
  privateId: string;
  privateTitle: string;
};

export const readSeed = (): Seed => JSON.parse(readFileSync(SEED_FILE, "utf8")) as Seed;
export { SEED_FILE };

/** A generated mono 16 kHz WAV: 8 s tone, 2 s silence, repeated, so the worker cuts several lines. */
export function toneWav(seconds: number): Buffer {
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

/** An API call as the test admin; throws on any non-2xx answer. */
export async function adminApi(
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
