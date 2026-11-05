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
  english_stale: false,
  english_edit_stale: false,
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

function patches(method = "PATCH") {
  return vi
    .mocked(fetch)
    .mock.calls.filter(([, init]) => init?.method === method)
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
    expect(screen.queryByRole("form", { name: "Edit line at 0:00" })).toBeNull();
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

describe("out-of-date English", () => {
  it("counts stale lines, flags English edits to check, and updates on request", async () => {
    const stale = { ...nepali, original_edited: "Edited original A", english_stale: true };
    const toCheck = {
      ...untranslated,
      english_machine: "Machine english C",
      english_edited: "Human english C",
      english_stale: true,
      english_edit_stale: true,
    };
    const routes = {
      ...api([stale, english, toCheck], { body: stale }),
      [`${base}/retranslate`]: { status: 202, body: { stale_lines: 2 } },
      [`${base}/segments/2`]: { body: { ...toCheck, english_edit_stale: false } },
    };
    stubApi(routes);
    renderApp(`/admin/interviews/${id}`, fakeAuthClient({ signedIn: true }));

    expect(
      await screen.findByText(/The English of 2 lines are out of date/, {}, SLOW),
    ).toBeTruthy();
    expect(screen.getByText("English update pending")).toBeTruthy();
    expect(screen.getByText(/The original changed after this English was edited/)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Update English now" }));
    expect(await screen.findByText(/Updating the English now/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Update English now" })).toHaveProperty(
      "disabled",
      true,
    );
    const posts = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts.map(([url]) => url)).toEqual([`${base}/retranslate`]);

    // Saving a flagged English edit unchanged confirms it was checked.
    await userEvent.click(screen.getByRole("button", { name: "Edit line at 1:10" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(patches()).toEqual([
      { url: `${base}/segments/2`, body: { english_text: "Human english C" } },
    ]);
  });

  it("explains when the update can't start", async () => {
    const stale = { ...nepali, original_edited: "Edited original A", english_stale: true };
    stubApi({
      ...api([stale], {}),
      [`${base}/retranslate`]: { status: 409, body: { detail: "transcribing" } },
    });
    renderApp(`/admin/interviews/${id}`, fakeAuthClient({ signedIn: true }));
    expect(await screen.findByText(/The English of 1 line is out of date/, {}, SLOW)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Update English now" }));
    expect(await screen.findByText(/This interview is being transcribed again/)).toBeTruthy();
  });
});

describe("faster editing", () => {
  it("plays just one line's audio and stops at its end", async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockReturnValue(undefined);
    stubApi(api([nepali, english], {}));
    renderApp(`/admin/interviews/${id}`, fakeAuthClient({ signedIn: true }));

    await userEvent.click(await screen.findByRole("button", { name: "Play line at 1:05" }, SLOW));
    const audio = document.querySelector("audio");
    expect(audio?.getAttribute("src")).toBe(interviewDetail.media.url);
    expect(audio?.currentTime).toBe(65);
    expect(play).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Stop line at 1:05" })).toBeTruthy();

    // Past the line's end (70 s), playback stops by itself.
    if (!audio) throw new Error("no audio element");
    audio.currentTime = 70.1;
    fireEvent.timeUpdate(audio);
    expect(pause).toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "Play line at 1:05" })).toBeTruthy();
    play.mockRestore();
    pause.mockRestore();
  });

  it("opens a line by clicking its text, saves with Enter and moves on with Tab", async () => {
    const saved = { ...nepali, original_edited: "Machine original A fixed" };
    const routes = api([nepali, english, untranslated], { body: saved });
    routes[`${base}/segments/1`] = { body: english };
    stubApi(routes);
    renderApp(`/admin/interviews/${id}`, fakeAuthClient({ signedIn: true }));

    await userEvent.click(await screen.findByText("Machine original A", {}, SLOW));
    const form = screen.getByRole("form", { name: "Edit line at 0:00" });
    const original = within(form).getByRole("textbox", { name: "Original" });
    expect(document.activeElement).toBe(original);
    routes[`${base}/transcript`] = { body: { items: [saved, english, untranslated] } };
    await userEvent.type(original, " fixed{Enter}");
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(patches()).toEqual([
      { url: `${base}/segments/0`, body: { original_text: "Machine original A fixed" } },
    ]);
    expect(screen.queryByRole("form", { name: "Edit line at 0:00" })).toBeNull();

    // Tab from the last box saves (nothing changed here) and opens the next line.
    await userEvent.click(screen.getByText("Machine original A fixed"));
    await userEvent.click(screen.getByRole("textbox", { name: "English" }));
    await userEvent.tab();
    const next = await screen.findByRole("form", { name: "Edit line at 1:05" });
    expect(document.activeElement).toBe(within(next).getByRole("textbox", { name: "Original" }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("form", { name: "Edit line at 1:05" })).toBeNull();
    expect(patches()).toHaveLength(1);
  });

  it("finds a misspelling, highlights it and replaces it in every line at once", async () => {
    const lineA = { ...nepali, english_machine: "Machine english Swayambu A" };
    const lineC = { ...untranslated, english_machine: "swayambu machine C" };
    const fixedA = { ...lineA, english_edited: "Machine english Swayambhu A" };
    const fixedC = { ...lineC, english_edited: "Swayambhu machine C" };
    const routes = {
      ...api([lineA, english, lineC], {}),
      [`${base}/transcript/replace`]: { body: { items: [fixedA, fixedC], skipped: 0 } },
    };
    stubApi(routes);
    renderApp(`/admin/interviews/${id}`, fakeAuthClient({ signedIn: true }));

    const panel = await screen.findByRole("form", { name: "Find and replace" }, SLOW);
    await userEvent.type(within(panel).getByRole("textbox", { name: "Find" }), "SWAYAMBU");
    // Searches the original by default, where it doesn't appear.
    expect(within(panel).getByText("0 lines match")).toBeTruthy();
    await userEvent.click(within(panel).getByRole("button", { name: "English" }));
    expect(within(panel).getByText("2 lines match")).toBeTruthy();
    expect([...document.querySelectorAll("mark")].map((m) => m.textContent)).toEqual([
      "Swayambu",
      "swayambu",
    ]);
    await userEvent.click(within(panel).getByRole("checkbox", { name: "Match case" }));
    expect(within(panel).getByText("0 lines match")).toBeTruthy();
    await userEvent.click(within(panel).getByRole("checkbox", { name: "Match case" }));

    await userEvent.type(within(panel).getByRole("textbox", { name: "Replace with" }), "Swayambhu");
    routes[`${base}/transcript`] = { body: { items: [fixedA, english, fixedC] } };
    await userEvent.click(within(panel).getByRole("button", { name: "Replace in 2 lines" }));
    expect((await within(panel).findByRole("status")).textContent).toMatch(/Replaced in 2 lines/);
    expect(patches("POST")).toEqual([
      {
        url: `${base}/transcript/replace`,
        body: { find: "SWAYAMBU", replace: "Swayambhu", field: "english", match_case: false },
      },
    ]);
    expect(screen.getByText("Swayambhu machine C")).toBeTruthy();
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
    expect(buildEdit(edited, { original: "X", english: "Y" }, { confirmEnglish: true })).toEqual({
      english_text: "Y",
    });
  });
});
