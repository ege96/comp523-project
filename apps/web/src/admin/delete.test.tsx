import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AdminSegment, InterviewDetail } from "../api/schemas";
import { interviewDetail } from "../test/fixtures";
import { fakeAuthClient, renderApp, stubApi } from "../test/renderApp";

const SLOW = { timeout: 5000 };

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

const detail: InterviewDetail = {
  ...interviewDetail,
  visibility: "private",
  translation_status: "done",
};
const path = `/api/interviews/${detail.id}`;

function line(seq: number, edited: string | null): AdminSegment {
  return {
    seq,
    start_ms: seq * 5000,
    end_ms: seq * 5000 + 4000,
    language: "ne",
    original_machine: "पहिलो",
    original_edited: edited,
    english_machine: "First",
    english_edited: null,
    edited_at: edited ? "2026-11-20T00:00:00Z" : null,
    english_stale: false,
    english_edit_stale: false,
    edited_by: edited ? "someone@example.org" : null,
  };
}

function routes(interview: InterviewDetail) {
  return {
    "/api/auth/me": { body: { id: 1, email: "someone@example.org" } },
    "/api/search/filters": { body: { languages: [], interviewees: [] } },
    "/api/interviews": { body: { items: [], total: 0 } },
    "/api/admin/interview-counts": { body: { items: [] } },
    "/api/storage": { body: { usable_bytes: 10_000, max_upload_bytes: 5_000 } },
    [path]: { body: interview },
    [`${path}/jobs`]: { body: { items: [] } },
    [`${path}/transcript`]: { body: { items: [line(0, "पहिलो!"), line(1, null)] } },
  };
}

function deletes() {
  return vi
    .mocked(fetch)
    .mock.calls.filter(([url, init]) => url === path && init?.method === "DELETE");
}

describe("deleting an interview", () => {
  it("says what goes, needs the word typed, then returns to the list with a notice", async () => {
    stubApi(routes(detail));
    const router = renderApp(`/admin/interviews/${detail.id}`, fakeAuthClient({ signedIn: true }));

    await userEvent.click(await screen.findByRole("button", { name: "Delete interview" }, SLOW));
    const dialog = await screen.findByRole("dialog", {
      name: `Delete “${detail.title}” for good?`,
    });
    expect(await within(dialog).findByText("The transcript: 2 lines")).toBeTruthy();
    expect(within(dialog).getByText("1 line corrected by admins")).toBeTruthy();
    expect(within(dialog).getByText("The recording (1:02:03)")).toBeTruthy();

    const confirm = within(dialog).getByRole("button", { name: "Delete for good" });
    await userEvent.type(within(dialog).getByRole("textbox"), "delet");
    expect(confirm).toHaveProperty("disabled", true);
    await userEvent.type(within(dialog).getByRole("textbox"), "e");
    await userEvent.click(confirm);

    await vi.waitFor(() => {
      expect(router.state.location.pathname).toBe("/admin");
    });
    expect(deletes()).toHaveLength(1);
    expect(await screen.findByText(/Deleted “Test interview A”/)).toBeTruthy();
    // The title travels in the history entry, not the address.
    expect(router.state.location.href).not.toContain("Test");
  });

  it("asks to unpublish a published interview first", async () => {
    stubApi(routes({ ...detail, visibility: "public" }));
    renderApp(`/admin/interviews/${detail.id}`, fakeAuthClient({ signedIn: true }));

    expect(await screen.findByText(/To delete it, unpublish it first/, {}, SLOW)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete interview" })).toBeNull();
  });

  it("explains a refusal when someone published it meanwhile", async () => {
    const api = routes(detail);
    stubApi(api);
    renderApp(`/admin/interviews/${detail.id}`, fakeAuthClient({ signedIn: true }));

    await userEvent.click(await screen.findByRole("button", { name: "Delete interview" }, SLOW));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByRole("textbox"), "delete");
    stubApi({ ...api, [path]: { status: 409, body: { detail: "published" } } });
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete for good" }));

    expect(await within(dialog).findByText(/Someone published it meanwhile/)).toBeTruthy();
  });

  it("offers deleting a wrong upload while it is processing", async () => {
    stubApi(routes({ ...detail, status: "processing" }));
    renderApp(`/admin/interviews/${detail.id}`, fakeAuthClient({ signedIn: true }));

    const link = await screen.findByRole("link", { name: "Delete this interview" }, SLOW);
    expect(link.getAttribute("href")).toBe("#delete");
  });
});
