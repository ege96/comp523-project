import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { interviewDetail, interviewSummary, segments } from "./test/fixtures";
import { fakeAuthClient, renderApp, stubApi } from "./test/renderApp";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

const processing = { ...interviewSummary, status: "processing" } as const;
const list = { "/api/interviews": { body: { items: [processing], total: 1 } } };

describe("app shell and sign-in", () => {
  it("shows visitors the archive without loading sign-in, and sends /admin to sign-in", async () => {
    const calls = stubApi(list);
    const loadClient = vi.fn();
    renderApp("/");

    expect(await screen.findByRole("link", { name: "Test interview A" })).toBeTruthy();
    // One line on phones, columns on wide screens (both are in the DOM; CSS picks one).
    expect(screen.getByText("Unknown interviewee · Nepali · 1:02:03 · May 2001")).toBeTruthy();
    expect(screen.getByText("May 2001")).toBeTruthy();
    expect(screen.getByText("Transcript in progress")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Upload & review" })).toBeNull();
    expect(calls).toEqual([{ path: "/api/interviews", auth: null }]);
    expect(loadClient).not.toHaveBeenCalled();

    await userEvent.type(screen.getByRole("textbox", { name: /search/i }), "  rituals {Enter}");
    expect(await screen.findByRole("heading", { name: "Search the archive" })).toBeTruthy();

    cleanup();
    renderApp("/admin");
    expect(await screen.findByRole("heading", { name: "Admin sign-in" })).toBeTruthy();
  });

  it("says so when the archive or sign-in can't be reached", async () => {
    stubApi({ "/api/interviews": { status: 500, body: {} } });
    renderApp("/no-such-page");
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeTruthy();

    cleanup();
    renderApp("/");
    expect(await screen.findByText(/Interviews couldn't be loaded/)).toBeTruthy();

    cleanup();
    renderApp("/signin"); // no Firebase config: loadClient resolves to null
    expect(await screen.findByText("Sign-in isn't available right now.")).toBeTruthy();
  });

  it("lets an admin into admin pages and sends their token with API requests", async () => {
    const calls = stubApi({
      ...list,
      "/api/auth/me": { body: { id: 1, email: "someone@example.org" } },
    });
    const router = renderApp("/signin", fakeAuthClient({ signedIn: false }));

    await userEvent.click(await screen.findByRole("button", { name: "Sign in with Google" }));
    expect(await screen.findByRole("heading", { name: "Upload & review" })).toBeTruthy();
    expect(screen.getByText(/Signed in as someone@example.org/)).toBeTruthy();

    await router.navigate({ to: "/" });
    await screen.findByRole("link", { name: "Test interview A" });
    expect(calls.find((c) => c.path === "/api/interviews")?.auth).toBe("Bearer tok");

    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("link", { name: "Admin sign-in" })).toBeTruthy();
    expect(localStorage.getItem("swayambhu.auth.v1")).toBeNull();
  });

  it("signs in with email and password, and sends a reset link without revealing accounts", async () => {
    stubApi({ "/api/auth/me": { body: { id: 1, email: "someone@example.org" } } });
    const client = fakeAuthClient({ signedIn: false });
    renderApp("/signin", client);

    const email = await screen.findByRole("textbox", { name: "Email" });
    await userEvent.type(email, "someone@example.org");
    await userEvent.click(screen.getByRole("button", { name: "Forgot password?" }));
    expect(await screen.findByText(/If someone@example.org has an account/)).toBeTruthy();
    expect(client.sent).toEqual(["reset:someone@example.org"]);

    await userEvent.type(screen.getByLabelText(/Password/), "wrong");
    await userEvent.click(screen.getByRole("button", { name: "Sign in with email" }));
    expect(await screen.findByText("That email and password don't match an account.")).toBeTruthy();

    await userEvent.clear(screen.getByLabelText(/Password/));
    await userEvent.type(screen.getByLabelText(/Password/), "pw{Enter}");
    expect(await screen.findByRole("heading", { name: "Upload & review" })).toBeTruthy();
  });

  it("tells a signed-in non-admin why the admin pages are closed", async () => {
    stubApi({ "/api/auth/me": { status: 403, body: { detail: "This account is not an admin" } } });
    renderApp("/admin", fakeAuthClient({ signedIn: true }));
    expect(await screen.findByText(/someone@example.org isn't an archive admin/)).toBeTruthy();
    expect(screen.getByText(/added by the archive's operator/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Admin sign-in" })).toBeTruthy();

    // An unverified email can't claim an admin invite yet, so offer the verification link.
    cleanup();
    const client = fakeAuthClient({ signedIn: true, emailVerified: false });
    renderApp("/signin", client);
    await userEvent.click(await screen.findByRole("button", { name: "Send link" }));
    expect(await screen.findByText(/Verification email sent/)).toBeTruthy();
    expect(client.sent).toEqual(["verify"]);
  });
});

describe("about and help", () => {
  it("is linked from every page and marks text the archive team still has to send", async () => {
    stubApi(list);
    renderApp("/");
    const footer = await screen.findByRole("contentinfo");
    await userEvent.click(within(footer).getByRole("link", { name: "About & Help" }));
    expect(await screen.findByRole("heading", { level: 1, name: "About & Help" })).toBeTruthy();
    expect(
      screen.getByRole("heading", {
        name: "How do I ask for a correction or for an interview to be removed?",
      }),
    ).toBeTruthy();
    expect(screen.getAllByText("Text to come from the archive team").length).toBeGreaterThan(0);
  });
});

describe("all interviews", () => {
  it("pages through the list with the page number in the URL", async () => {
    stubApi({ "/api/interviews": { body: { items: [interviewSummary], total: 45 } } });
    const router = renderApp("/");
    await userEvent.click(await screen.findByRole("link", { name: /Browse all interviews/ }));
    expect(await screen.findByRole("heading", { name: "All interviews" })).toBeTruthy();

    await userEvent.click(await screen.findByRole("link", { name: "Go to page 3" }));
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ page: 3 });
    });
    const urls = vi.mocked(fetch).mock.calls.map(([url]) => url);
    expect(urls).toContain("/api/interviews?limit=20&offset=40");
    expect(screen.getByRole("link", { name: "page 3" }).getAttribute("aria-current")).toBe("page");
  });
});

describe("search", () => {
  const moment = {
    interview: interviewSummary,
    start_ms: 754_000,
    end_ms: 790_000,
    excerpt: [{ ...segments.items[0], english_text: "English text A" }],
    matched_by: ["semantic"],
  };
  const keywordMoment = {
    interview: { ...interviewSummary, title: "Test interview B", recorded_on: null },
    excerpt: segments.items,
    matched_by: ["keyword"],
  };

  it("shows moments with filters in the URL and opens the viewer at the moment", async () => {
    const id = interviewSummary.id;
    stubApi({
      "/api/search": {
        body: {
          // The second is a plain word match with no translation and no recording date.
          items: [moment, { ...moment, ...keywordMoment }],
          has_more: true,
          search_mode: "keyword_only",
        },
      },
      "/api/search/filters": {
        body: { languages: [{ code: "ne", name: "Nepali" }], interviewees: [] },
      },
      [`/api/interviews/${id}`]: { body: interviewDetail },
      [`/api/interviews/${id}/segments`]: { body: segments },
    });
    const router = renderApp("/search?q=rituals");
    const urls = () => vi.mocked(fetch).mock.calls.map(([url]) => url);

    expect(await screen.findByRole("heading", { name: "Test interview A" })).toBeTruthy();
    expect(screen.getByText("English text A").getAttribute("lang")).toBe("en");
    expect(screen.getAllByText("Original text A")[0]?.getAttribute("lang")).toBe("ne");
    expect(screen.getAllByText(/Related in meaning/)).toHaveLength(1);
    expect(screen.getByText(/only match your words/)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Show more moments" }));
    await waitFor(() => {
      expect(urls()).toContain("/api/search?q=rituals&limit=20&offset=20");
    });

    await userEvent.click(screen.getByRole("combobox", { name: "Language" }));
    await userEvent.click(await screen.findByRole("option", { name: "Nepali" }));
    await userEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ q: "rituals", language: "ne" });
    });
    expect(urls()).toContain("/api/search?q=rituals&limit=20&offset=0&language=ne");

    const open = await screen.findAllByRole("link", { name: "Open Test interview A at 12:34" });
    await userEvent.click(open[0] as HTMLElement);
    await screen.findByRole("heading", { level: 1, name: "Test interview A" });
    await screen.findByRole("button", { name: "Play from 12:34" });
    expect(document.querySelector("audio")?.getAttribute("src")).toBe("/api/media/m1?sig=x#t=754");
    expect(screen.getByText("Original text A").closest("li")?.getAttribute("aria-current")).toBe(
      "true",
    );
  });

  it("keeps filters from a shared link, says when nothing matched, and clears them", async () => {
    stubApi({
      "/api/search": { body: { items: [], has_more: false, search_mode: "hybrid" } },
      "/api/search/filters": { body: { languages: [], interviewees: [] } },
    });
    const router = renderApp("/search?q=x&interviewee=7&from=2001-01-01&undated=true");
    expect(await screen.findByText(/No moments matched/)).toBeTruthy();
    // On phones the filters fold behind a button that says how many are on.
    const toggle = screen.getByRole("button", { name: "Filters · 2 on" });
    await userEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("combobox", { name: "Interviewee" }).textContent).toBe("Interviewee 7");
    expect(screen.getByRole("checkbox", { name: /undated/ })).toHaveProperty("checked", true);
    expect(screen.getByRole("textbox", { name: "From year" })).toHaveProperty("value", "2001");
    // Years typed the wrong way round become the span between them.
    await userEvent.type(screen.getByRole("textbox", { name: "To year" }), "1990");
    await userEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({ from: "1990-01-01", to: "2001-12-31" });
    });
    await userEvent.click(await screen.findByRole("button", { name: "Clear" }));
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ q: "x" });
    });
  });
});

describe("interview viewer", () => {
  const id = interviewSummary.id;

  it("shows the transcript, seeks the player, and explains a missing translation", async () => {
    stubApi({
      [`/api/interviews/${id}`]: { body: interviewDetail },
      [`/api/interviews/${id}/segments`]: { body: segments },
    });
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    renderApp(`/interviews/${id}`);

    expect(await screen.findByRole("heading", { name: "Test interview A" })).toBeTruthy();
    expect(screen.getByText("Interviewee B · Nepali · Recorded May 2001")).toBeTruthy();
    expect(screen.getByText("Interviewer C")).toBeTruthy();
    expect(await screen.findByText("Original text A")).toBeTruthy();
    expect(screen.getByText(/Transcribed by machine, so it may contain errors/)).toBeTruthy();
    expect(screen.queryByText("Corrected")).toBeNull();
    // Cards and the header only label a transcript that isn't there yet.
    expect(screen.queryByText(/Transcript in progress|Machine-generated/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Play from 12:34" }));
    expect(play).toHaveBeenCalled();
    expect(document.querySelector("audio")?.currentTime).toBe(754);

    await userEvent.click(
      within(screen.getByRole("tablist")).getByRole("tab", { name: "English" }),
    );
    expect(screen.getByText("The English translation is still being made.")).toBeTruthy();
  });

  it("shows admins a private video with its English translation and processing detail", async () => {
    stubApi({
      "/api/auth/me": { body: { id: 1, email: "someone@example.org" } },
      [`/api/interviews/${id}`]: {
        body: {
          ...interviewDetail,
          visibility: "private",
          translation_status: "done",
          status_detail: "Step: index",
          media: { ...interviewDetail.media, content_type: "video/mp4" },
        },
      },
      [`/api/interviews/${id}/segments`]: {
        body: {
          items: [{ ...segments.items[0], english_text: "English text A", english_edited: true }],
        },
      },
    });
    renderApp(`/interviews/${id}`, fakeAuthClient({ signedIn: true }));

    expect(await screen.findByText("Private")).toBeTruthy();
    expect(screen.getByText("Step: index")).toBeTruthy();
    expect(document.querySelector("video")).toBeTruthy();
    await userEvent.click(await screen.findByRole("tab", { name: "English" }));
    expect(screen.getByText("English text A")).toBeTruthy();
    // Only the English of this line was corrected.
    expect(screen.getByText(/translated by machine.*Lines marked “Corrected”/)).toBeTruthy();
    expect(screen.getByText("Corrected")).toBeTruthy();
    await userEvent.click(screen.getByRole("tab", { name: "Original" }));
    expect(screen.queryByText("Corrected")).toBeNull();
  });

  it("finds words in the transcript, steps through the lines and follows the tab", async () => {
    const line = (seq: number, original: string, english: string | null) => ({
      ...segments.items[0],
      seq,
      start_ms: seq * 10_000,
      end_ms: seq * 10_000 + 10_000,
      original_text: original,
      english_text: english,
    });
    stubApi({
      [`/api/interviews/${id}`]: { body: { ...interviewDetail, translation_status: "done" } },
      [`/api/interviews/${id}/segments`]: {
        body: {
          items: [
            line(0, "Stupa at dawn", "The stupa"),
            line(1, "Nothing here", "Dawn prayers"),
            line(2, "Back to the STUPA", null),
          ],
        },
      },
    });
    renderApp(`/interviews/${id}`);
    const find = await screen.findByRole("searchbox", { name: "Find in transcript" });
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;

    await userEvent.type(find, "stupa");
    expect(screen.getByRole("status").textContent).toBe("1 of 2 lines");
    // With a translation the viewer opens on both languages, so both are searched.
    expect([...document.querySelectorAll("mark")].map((m) => m.textContent)).toEqual([
      "Stupa",
      "stupa",
      "STUPA",
    ]);
    expect(scroll).toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("status").textContent).toBe("2 of 2 lines");
    await userEvent.type(find, "{Enter}"); // wraps round to the first
    expect(screen.getByRole("status").textContent).toBe("1 of 2 lines");

    // The English tab searches what it shows (the original where a line has no English).
    await userEvent.click(screen.getByRole("tab", { name: "English" }));
    expect(screen.getByRole("status").textContent).toBe("1 of 2 lines");
    await userEvent.clear(find);
    await userEvent.type(find, "temple");
    expect(screen.getByRole("status").textContent).toBe("No lines match");
    expect(document.querySelector("mark")).toBeNull();

    expect(screen.getByRole("link", { name: "Learn more" }).getAttribute("href")).toBe(
      "/about#machine-transcripts",
    );
  });

  it("opens on both languages when there is a translation, and can show one", async () => {
    stubApi({
      [`/api/interviews/${id}`]: { body: { ...interviewDetail, translation_status: "done" } },
      [`/api/interviews/${id}/segments`]: {
        body: { items: [{ ...segments.items[0], english_text: "English text A" }] },
      },
    });
    renderApp(`/interviews/${id}`);
    const both = await screen.findByRole("tab", { name: "Original + English" });
    expect(both.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Original text A").getAttribute("lang")).toBe("ne");
    expect(screen.getByText("English text A")).toBeTruthy();
    await userEvent.click(screen.getByRole("tab", { name: "Original" }));
    expect(screen.queryByText("English text A")).toBeNull();
  });

  it("treats a 404 as missing or private, without saying which", async () => {
    stubApi({});
    renderApp(`/interviews/${id}`);
    expect(await screen.findByText("This interview doesn't exist, or isn't public.")).toBeTruthy();
  });
});
