// Shared fixtures: `seed` is what global-setup made; `adminPage` is a page signed in as the
// test admin through the real sign-in form (Firebase answered by support/auth.ts).
import { test as base, expect, type Page } from "@playwright/test";

import { ADMIN, mockFirebase } from "./support/auth";
import { readSeed, type Seed } from "./support/seed";

export const test = base.extend<{ adminPage: Page }, { seed: Seed }>({
  seed: [
    async ({}, use) => {
      await use(readSeed());
    },
    { scope: "worker" },
  ],
  adminPage: async ({ page }, use) => {
    await mockFirebase(page);
    await page.goto("/signin");
    await page.getByLabel("Email").fill(ADMIN.email);
    await page.getByLabel("Password").fill(ADMIN.password);
    await page.getByRole("button", { name: "Sign in with email" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Upload & review" })).toBeVisible();
    await use(page);
  },
});

export { expect };
