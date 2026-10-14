import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { interviewDetail, interviewSummary, segments } from "./test/fixtures";
import { fakeAuthClient, renderApp, stubApi } from "./test/renderApp";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

const list = { "/api/interviews": { body: { items: [interviewSummary], total: 1 } } };

describe("app shell and sign-in", () => {
  it("shows visitors the archive without loading sign-in, and sends /admin to sign-in", async () => {
    const calls = stubApi(list);
    const loadClient = vi.fn();
    renderApp("/");

    expect(await screen.findByRole("link", { name: "Test interview A" })).toBeTruthy();
    expect(
      screen.getByText(/Unknown interviewee · Nepali · 1:02:03 · Recorded May 2001/),
    ).toBeTruthy();
    expect(screen.getByText("Machine-generated transcript")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Upload & review" })).toBeNull();
    expect(calls).toEqual([{ path: "/api/interviews", auth: null }]);
    expect(loadClient).not.toHaveBeenCalled();

    await userEvent.type(screen.getByRole("textbox", { name: /search/i }), "  rituals {Enter}");
    expect(await screen.findByText(/no results for “rituals” yet/)).toBeTruthy();

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

  it("tells a signed-in non-admin why the admin pages are closed", async () => {
    stubApi({ "/api/auth/me": { status: 403, body: { detail: "This account is not an admin" } } });
    renderApp("/admin", fakeAuthClient({ signedIn: true }));
    expect(await screen.findByText(/someone@example.org isn't an archive admin/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Admin sign-in" })).toBeTruthy();
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
        body: { items: [{ ...segments.items[0], english_text: "English text A" }] },
      },
    });
    renderApp(`/interviews/${id}`, fakeAuthClient({ signedIn: true }));

    expect(await screen.findByText("Private")).toBeTruthy();
    expect(screen.getByText("Step: index")).toBeTruthy();
    expect(document.querySelector("video")).toBeTruthy();
    await userEvent.click(await screen.findByRole("tab", { name: "English" }));
    expect(screen.getByText("English text A")).toBeTruthy();
  });

  it("treats a 404 as missing or private, without saying which", async () => {
    stubApi({});
    renderApp(`/interviews/${id}`);
    expect(await screen.findByText("This interview doesn't exist, or isn't public.")).toBeTruthy();
  });
});
