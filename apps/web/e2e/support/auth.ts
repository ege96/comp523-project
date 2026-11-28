// Test-only stand-in for Firebase Auth. The API checks tokens against e2e/.auth/jwks.json
// (FIREBASE_JWKS_URL), and the browser's calls to Google are answered by `mockFirebase`.
import { createPrivateKey, createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

export const PROJECT_ID = "comp523-e2e";
export const ADMIN = { uid: "e2e-admin", email: "e2e-admin@example.org", password: "e2e-pass" };
export const AUTH_DIR = path.join(import.meta.dirname, "..", ".auth");
const KEY_FILE = path.join(AUTH_DIR, "private.pem");
const KID = "e2e";

/** Makes the signing key and the JWKS the API reads, once per checkout. */
export function ensureKeys(): void {
  if (existsSync(KEY_FILE)) return;
  mkdirSync(AUTH_DIR, { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" };
  // Only the public half is served to the API (compose.e2e.yaml's jwks service).
  mkdirSync(path.join(AUTH_DIR, "jwks"), { recursive: true });
  writeFileSync(path.join(AUTH_DIR, "jwks", "jwks.json"), JSON.stringify({ keys: [jwk] }));
  writeFileSync(KEY_FILE, privateKey.export({ format: "pem", type: "pkcs8" }));
}

const b64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");
let key: KeyObject | undefined;

/** A Firebase-shaped ID token for the admin, signed with the test key. */
export function idToken(user = ADMIN): string {
  key ??= createPrivateKey(readFileSync(KEY_FILE));
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: KID }));
  const claims = b64url(
    JSON.stringify({
      iss: `https://securetoken.google.com/${PROJECT_ID}`,
      aud: PROJECT_ID,
      sub: user.uid,
      user_id: user.uid,
      auth_time: now,
      iat: now,
      exp: now + 3600,
      email: user.email,
      email_verified: true,
      firebase: { sign_in_provider: "password", identities: { email: [user.email] } },
    }),
  );
  const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(key);
  return `${header}.${claims}.${b64url(signature)}`;
}

/** Answers the Firebase JS SDK's email/password sign-in with a token for ADMIN. */
export async function mockFirebase(page: Page): Promise<void> {
  await page.route("https://identitytoolkit.googleapis.com/**", async (route) => {
    const url = route.request().url();
    const user = {
      localId: ADMIN.uid,
      email: ADMIN.email,
      emailVerified: true,
      providerUserInfo: [{ providerId: "password", email: ADMIN.email, rawId: ADMIN.email }],
      createdAt: "0",
      lastLoginAt: String(Date.now()),
    };
    if (url.includes("accounts:signInWithPassword")) {
      const body = route.request().postDataJSON() as { email: string; password: string };
      if (body.email !== ADMIN.email || body.password !== ADMIN.password) {
        await route.fulfill({
          status: 400,
          json: { error: { code: 400, message: "INVALID_LOGIN_CREDENTIALS" } },
        });
        return;
      }
      await route.fulfill({
        json: {
          ...user,
          registered: true,
          idToken: idToken(),
          refreshToken: "e2e-refresh",
          expiresIn: "3600",
        },
      });
    } else if (url.includes("accounts:lookup")) {
      await route.fulfill({ json: { users: [user] } });
    } else {
      await route.fulfill({
        status: 400,
        json: { error: { code: 400, message: `e2e mock: ${url}` } },
      });
    }
  });
}
