// What an admin does: sort the work by tab, correct a transcript, and take a new recording
// from upload to published and back out of the archive. Visitors are checked in their own
// signed-out browser context.
import { expect, test } from "./fixtures";
import { toneWav } from "./support/seed";

test("an admin sees each interview under one tab and corrects a published transcript", async ({
  adminPage: page,
  browser,
  seed,
}) => {
  const tabs = page.getByRole("tablist", { name: "Show interviews that are" });
  const row = (title: string) => page.getByRole("link", { name: title, exact: true });

  await tabs.getByRole("tab", { name: /^Not published/ }).click();
  await expect(page).toHaveURL(/view=ready/);
  await expect(row(seed.privateTitle)).toBeVisible();
  await expect(row(seed.publicTitle)).toHaveCount(0);

  await tabs.getByRole("tab", { name: /^Published/ }).click();
  await expect(page).toHaveURL(/view=published/);
  await expect(row(seed.publicTitle)).toBeVisible();
  await expect(row(seed.privateTitle)).toHaveCount(0);

  await page.getByRole("link", { name: `Open: ${seed.publicTitle}` }).click();
  await expect(page.getByRole("heading", { level: 1, name: seed.publicTitle })).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 2, name: "Published", exact: true }),
  ).toBeVisible();

  await page
    .getByRole("button", { name: /^Edit line at / })
    .first()
    .click();
  const fixed = `Corrected by e2e ${Date.now().toString(36)}`;
  await page.getByRole("textbox", { name: "Original" }).fill(fixed);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: /^Saved\./ })).toBeVisible();

  // A signed-out visitor sees the correction, marked as such.
  const visitor = await browser.newPage();
  await visitor.goto(`/interviews/${seed.publicId}`);
  await expect(visitor.getByText(fixed)).toBeVisible();
  await expect(visitor.getByText("Corrected", { exact: true })).toBeVisible();
  await visitor.close();
});

test("an admin uploads a recording, publishes it, then unpublishes and deletes it", async ({
  adminPage: page,
  browser,
}) => {
  const run = Date.now().toString(36);
  const file = `e2e-upload-${run}.wav`;
  const title = `E2E uploaded recording ${run}`;

  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Choose files" }).click();
  await (await chooser).setFiles({ name: file, mimeType: "audio/wav", buffer: toneWav(20) });
  const upload = page.getByRole("group", { name: file });
  await upload.getByRole("textbox", { name: "Interview title" }).fill(title);
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  await upload.getByRole("link", { name: "Follow its progress" }).click();

  // The page follows processing live (no reload) until the transcript is finished.
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  // The "Next step" panel's heading names the stage the recording is at.
  const stage = (name: string) => page.getByRole("heading", { level: 2, name, exact: true });
  await expect(stage("Finished, not published")).toBeVisible({ timeout: 60_000 });

  await page.getByRole("button", { name: "Publish", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: `Publish “${title}”?` });
  await confirm.getByRole("button", { name: "Publish" }).click();
  await expect(stage("Published")).toBeVisible();
  const id = new URL(page.url()).pathname.split("/").pop() ?? "";

  const visitor = await browser.newPage();
  await visitor.goto(`/interviews/${id}`);
  await expect(visitor.getByRole("heading", { level: 1, name: title })).toBeVisible();

  // Deleting needs it unpublished first, then the typed confirmation.
  await page.getByRole("button", { name: "Unpublish" }).click();
  await expect(stage("Finished, not published")).toBeVisible();
  await page.getByRole("button", { name: "Delete interview" }).click();
  const remove = page.getByRole("dialog", { name: `Delete “${title}” for good?` });
  const deleteForGood = remove.getByRole("button", { name: "Delete for good" });
  await expect(deleteForGood).toBeDisabled();
  await remove.getByRole("textbox", { name: "Type “delete” to confirm" }).fill("delete");
  await deleteForGood.click();
  await expect(page).toHaveURL(/\/admin(\?|$)/);
  await expect(page.getByRole("status").filter({ hasText: `Deleted “${title}”` })).toBeVisible();

  await visitor.reload();
  await expect(visitor.getByText("This interview doesn't exist, or isn't public.")).toBeVisible();
  await visitor.close();
});
