// What an anonymous visitor can do, and what they must never reach.
import { expect, test } from "./fixtures";
import { API_URL } from "./support/seed";

test("a visitor searches from the home page and opens a moment at its time", async ({
  page,
  seed,
}) => {
  await page.goto("/");
  const box = page.getByRole("textbox", { name: "Search interview transcripts" });
  await box.fill("fake transcript");
  await box.press("Enter");

  await expect(page).toHaveURL(/\/search\?q=fake/);
  const moments = page.getByRole("article", { name: seed.publicTitle });
  await expect(moments.first()).toBeVisible();
  await expect(page.getByRole("article", { name: seed.privateTitle })).toHaveCount(0);

  await moments
    .first()
    .getByRole("link", { name: new RegExp(`^Open at [\\d:]+, ${seed.publicTitle}$`) })
    .click();
  await expect(page).toHaveURL(new RegExp(`/interviews/${seed.publicId}\\?t=\\d+`));
  await expect(page.getByRole("heading", { level: 1, name: seed.publicTitle })).toBeVisible();
});

test("the viewer plays the recording and seeks from a transcript line", async ({ page, seed }) => {
  await page.goto(`/interviews/${seed.publicId}`);
  // <audio> has no ARIA role; it sits in the page's "Recording" region.
  const audio = page.getByRole("complementary", { name: "Recording" }).locator("audio");
  await expect(audio).toBeVisible();
  // The signed media link serves audio the browser can decode.
  await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.duration)).toBeGreaterThan(30);
  await audio.evaluate((a: HTMLAudioElement) => (a.muted = true));

  const lines = page.getByRole("button", { name: /^Play from \d+:\d{2}$/ });
  await expect(lines.nth(1)).toBeVisible();
  const last = lines.last();
  const [m = 0, s = 0] = ((await last.getAttribute("aria-label")) ?? "")
    .replace("Play from ", "")
    .split(":")
    .map(Number);
  await last.click();
  await expect
    .poll(() => audio.evaluate((a: HTMLAudioElement) => a.currentTime))
    .toBeGreaterThanOrEqual(m * 60 + s);
  // The URL points at the line's start, in milliseconds.
  await expect(page).toHaveURL(new RegExp(`\\?t=${String(m * 60 + s)}\\d{3}$`));
});

test("the public pages are reachable from the main navigation", async ({ page, seed }) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Main" });

  await nav.getByRole("link", { name: "Interviews" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "All interviews" })).toBeVisible();
  await page.getByRole("link", { name: seed.publicTitle }).click();
  await expect(page.getByRole("heading", { level: 1, name: seed.publicTitle })).toBeVisible();

  await nav.getByRole("link", { name: "About" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "About & Help" })).toBeVisible();

  await page.goto("/no-such-page");
  await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
});

test("a Private interview is hidden from visitors on every page and API route", async ({
  page,
  request,
  seed,
}) => {
  await page.goto(`/interviews/${seed.privateId}`);
  await expect(page.getByText("This interview doesn't exist, or isn't public.")).toBeVisible();

  await page.goto("/interviews");
  await expect(page.getByRole("link", { name: seed.publicTitle })).toBeVisible();
  await expect(page.getByRole("link", { name: seed.privateTitle })).toHaveCount(0);

  await page.goto(`/search?q=${encodeURIComponent(seed.privateTitle)}`);
  await expect(page.getByRole("heading", { name: "Search results" })).toBeVisible();
  await expect(page.getByText(seed.privateTitle)).toHaveCount(0);

  // The server enforces it, not just the pages.
  for (const route of [
    `/api/interviews/${seed.privateId}`,
    `/api/interviews/${seed.privateId}/segments`,
  ]) {
    expect((await request.get(`${API_URL}${route}`)).status(), route).toBe(404);
  }
  const list = (await (await request.get(`${API_URL}/api/interviews?limit=100`)).json()) as {
    items: { id: string }[];
  };
  expect(list.items.map((i) => i.id)).not.toContain(seed.privateId);
  const search = (await (
    await request.get(`${API_URL}/api/search`, { params: { q: seed.privateTitle } })
  ).json()) as { items: { interview: { id: string } }[]; interviews: { id: string }[] };
  expect([
    ...search.items.map((m) => m.interview.id),
    ...search.interviews.map((i) => i.id),
  ]).not.toContain(seed.privateId);
});
