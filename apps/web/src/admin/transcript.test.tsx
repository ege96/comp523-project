import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AdminSegment } from "../api/schemas";
import { interviewDetail } from "../test/fixtures";
import { fakeAuthClient, renderApp, stubApi } from "../test/renderApp";
import { buildEdit } from "./segmentEdit";

// The admin pages load on demand, which can be slow on a busy CI runner.
const SLOW = { timeout: 5000 };

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

const id = interviewDetail.id;
const base = `/api/interviews/${id}`;

// Obviously made-up lines (project rule: no mockup text).
const nepali: AdminSegment = {
  seq: 0,
  start_ms: 0,
  end_ms: 5_000,
  language: "ne",
  original_machine: "Machine original A",
  original_edited: null,
  english_machine: "Machine english A",
  english_edited: null,
  edited_at: null,
  edited_by: null,
};
const english: AdminSegment = {
  ...nepali,
  seq: 1,
  start_ms: 65_000,
  end_ms: 70_000,
  language: "en",
  original_machine: "Machine english speech B",
  english_machine: null,
};
const untranslated: AdminSegment = {
  ...nepali,
  seq: 2,
  start_ms: 70_000,
  end_ms: 75_000,
  original_machine: "Machine original C",
  english_machine: null,
};

function api(lines: AdminSegment[], patch: { status?: number; body?: unknown }) {
  return {
    "/api/auth/me": { body: { id: 1, email: "someone@example.org" } },
    [base]: { body: interviewDetail },
    [`${base}/jobs`]: { body: { items: [] } },
    [`${base}/transcript`]: { body: { items: lines } },
    [`${base}/segments/0`]: patch,
  };
}

function patches() {
  return vi
    .mocked(fetch)
    .mock.calls.filter(([, init]) => init?.method === "PATCH")
    .map(([url, init]) => ({
      url: url as string,
      body: JSON.parse(init?.body as string) as unknown,
    }));
}

describe("transcript editor", () => {
  it("saves a correction, keeps the machine text and shows the line as edited", async () => {
    const saved = { ...nepali, english_edited: "Corrected english A", edited_by: "a@example.org" };
    const routes = api([nepali, english, untranslated], { body: saved });
    stubApi(routes);
    renderApp(`/admin/interviews/${id}`, fakeAuthClient({ signedIn: true }));

    expect(await screen.findByText("Machine original A", {}, SLOW)).toBeTruthy();
    expect(screen.getByText("No English translation")).toBeTruthy();
    // English speech has no separate translation line.
    expect(screen.getAllByText(/Machine english/)).toHaveLength(2);

    await userEvent.click(screen.getByRole("button", { name: "Edit line at 0:00" }));
    const form = screen.getByRole("form", { name: "Edit line at 0:00" });
    const englishBox = within(form).getByRole("textbox", { name: "English" });
    fireEvent.change(englishBox, { target: { value: "  Corrected english A " } });
    expect(within(form).getByText("Machine: Machine english A")).toBeTruthy();

    routes[`${base}/transcript`] = { body: { items: [saved, english, untranslated] } };
    await userEvent.click(within(form).getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("status")).toBeTruthy();
    expect(patches()).toEqual([
      { url: `${base}/segments/0`, body: { english_text: "Corrected english A" } },
    ]);
    expect(screen.getByText("Corrected english A")).toBeTruthy();
    expect(screen.getByText("Edited")).toBeTruthy();
    expect(screen.getByText("by a@example.org")).toBeTruthy();
  });

  it("undoes an edit with the machine text and refuses empty text", async () => {
    const edited = { ...nepali, original_edited: "Edited original A", edited_by: null };
    stubApi(api([edited], { body: nepali }));
    renderApp(`/admin/interviews/${id}`, fakeAuthClient({ signedIn: true }));

    await userEvent.click(await screen.findByRole("button", { name: "Edit line at 0:00" }, SLOW));
    const form = screen.getByRole("form", { name: "Edit line at 0:00" });
    const original = within(form).getByRole("textbox", { name: "Original" });
    await userEvent.clear(original);
    expect(within(form).getByText("The original text can't be empty.")).toBeTruthy();
    expect(within(form).getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
    const englishBox = within(form).getByRole("textbox", { name: "English" });
    await userEvent.clear(englishBox);
    expect(within(form).getByText(/The English can't be empty/)).toBeTruthy();

    await userEvent.click(
      within(form).getByRole("button", { name: "Use machine text for English" }),
    );
    await userEvent.click(
      within(form).getByRole("button", { name: "Use machine text for Original" }),
    );
    await userEvent.click(within(form).getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(patches()).toEqual([{ url: `${base}/segments/0`, body: { original_text: null } }]);
  });

  it("closes without saving when nothing changed, and on cancel", async () => {
    stubApi(api([nepali], { body: nepali }));
    renderApp(`/admin/interviews/${id}`, fakeAuthClient({ signedIn: true }));

    const edit = await screen.findByRole("button", { name: "Edit line at 0:00" }, SLOW);
    await userEvent.click(edit);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await userEvent.click(screen.getByRole("button", { name: "Edit line at 0:00" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(patches()).toEqual([]);
  });

  it("explains a refused save and keeps what was typed", async () => {
    stubApi(api([nepali], { status: 409, body: { detail: "transcribing" } }));
    renderApp(`/admin/interviews/${id}`, fakeAuthClient({ signedIn: true }));

    await userEvent.click(await screen.findByRole("button", { name: "Edit line at 0:00" }, SLOW));
    const original = screen.getByRole("textbox", { name: "Original" });
    fireEvent.change(original, { target: { value: "Machine original A more" } });
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/being transcribed again/);
    expect(original).toHaveProperty("value", "Machine original A more");
  });

  it("says when there is no transcript, or it can't be loaded", async () => {
    stubApi(api([], {}));
    renderApp(`/admin/interviews/${id}`, fakeAuthClient({ signedIn: true }));
    expect(await screen.findByText(/There's no transcript yet/, {}, SLOW)).toBeTruthy();

    cleanup();
    stubApi({ ...api([], {}), [`${base}/transcript`]: { status: 500, body: {} } });
    renderApp(`/admin/interviews/${id}`, fakeAuthClient({ signedIn: true }));
    expect(await screen.findByText("The transcript couldn't be loaded.", {}, SLOW)).toBeTruthy();
  });
});

describe("buildEdit", () => {
  it("sends only what changed, and null when it's back to the machine text", () => {
    const edited = { ...nepali, original_edited: "X", english_edited: "Y" };
    expect(
      buildEdit(nepali, { original: "Machine original A", english: "Machine english A" }),
    ).toBe(null);
    expect(buildEdit(edited, { original: "Machine original A ", english: "Y" })).toEqual({
      original_text: null,
    });
    expect(buildEdit(untranslated, { original: "Machine original C", english: "New" })).toEqual({
      english_text: "New",
    });
    expect(buildEdit(edited, { original: "X", english: "Machine english A" })).toEqual({
      english_text: null,
    });
  });
});
