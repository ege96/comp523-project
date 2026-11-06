import { expect, test } from "@playwright/test";

import { ADMIN, mockFirebase } from "./support/auth";
import { API_URL, seed } from "./support/seed";

const { publicId, publicTitle, privateId, privateTitle } = seed();

test("a visitor searches from the home page and opens a moment", async ({ page }) => {
  await page.goto("/");
  const box = page.getByRole("textbox", { name: "Search interview transcripts" });
  await box.fill("fake transcript");
  await box.press("Enter");

  await expect(page).toHaveURL(/\/search\?/);
  const moment = page.getByRole("article").filter({ hasText: publicTitle }).first();
  await expect(moment).toBeVisible();
  await expect(page.getByText(privateTitle)).toHaveCount(0);

  await moment.getByRole("link", { name: `Open ${publicTitle}` }).click();
  await expect(page.getByRole("heading", { level: 1, name: publicTitle })).toBeVisible();
});

test("the interview viewer plays the recording and seeks from the transcript", async ({ page }) => {
  await page.goto(`/interviews/${publicId}`);
  const audio = page.locator("audio");
  await expect(audio).toBeVisible();
  // The signed media link actually serves audio the browser can decode.
  await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.duration)).toBeGreaterThan(30);

  const lines = page.getByRole("button", { name: /^Play from / });
  expect(await lines.count()).toBeGreaterThan(1);
  const last = lines.last();
  const label = (await last.getAttribute("aria-label")) ?? "";
  const [m, s] = label.replace("Play from ", "").split(":").map(Number);
  await audio.evaluate((a: HTMLAudioElement) => (a.muted = true));
  await last.click();
  await expect
    .poll(() => audio.evaluate((a: HTMLAudioElement) => a.currentTime))
    .toBeGreaterThanOrEqual((m ?? 0) * 60 + (s ?? 0));
});

test("a Private interview is hidden from visitors everywhere", async ({ page, request }) => {
  await page.goto(`/interviews/${privateId}`);
  await expect(page.getByText("This interview doesn't exist, or isn't public.")).toBeVisible();

  await page.goto("/interviews");
  await expect(page.getByText(publicTitle)).toBeVisible();
  await expect(page.getByText(privateTitle)).toHaveCount(0);

  // The server enforces it, not just the pages.
  expect((await request.get(`${API_URL}/api/interviews/${privateId}`)).status()).toBe(404);
  expect((await request.get(`${API_URL}/api/interviews/${privateId}/segments`)).status()).toBe(404);
  const list = (await (await request.get(`${API_URL}/api/interviews?limit=100`)).json()) as {
    items: { id: string }[];
  };
  expect(list.items.map((i) => i.id)).not.toContain(privateId);
});

test("an admin signs in and corrects a transcript line", async ({ page }) => {
  await mockFirebase(page);
  await page.goto("/signin");
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in with email" }).click();
  await expect(page).toHaveURL(/\/admin/);

  // Admins see Private interviews in their list.
  await expect(page.getByText(privateTitle)).toBeVisible();
  await page.goto(`/admin/interviews/${publicId}`);
  await page
    .getByRole("button", { name: /^Edit line at / })
    .first()
    .click();
  const fixed = `Corrected by e2e ${String(Date.now())}`;
  await page.getByLabel("Original").fill(fixed);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/^Saved\./)).toBeVisible();

  // Visitors see the correction, marked as such.
  await page.goto(`/interviews/${publicId}`);
  await expect(page.getByText(fixed)).toBeVisible();
  await expect(page.getByText("Corrected", { exact: true })).toBeVisible();
});
