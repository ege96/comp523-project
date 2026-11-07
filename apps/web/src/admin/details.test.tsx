import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { InterviewDetail } from "../api/schemas";
import { interviewDetail } from "../test/fixtures";
import { fakeAuthClient, renderApp, stubApi } from "../test/renderApp";
import { changedFields, detectedLabel, recordedOnText } from "./details";

const SLOW = { timeout: 5000 };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const detail: InterviewDetail = {
  ...interviewDetail,
  visibility: "private",
  primary_language: { code: "ne", name: "Nepali" },
  language_detected: "ne",
  language_detected_confidence: 0.92,
  language_confirmed: null,
};
const unchanged = {
  title: detail.title,
  interviewee: { id: 7, name: "Interviewee B" },
  recordedOn: "2001-05",
  language: "",
};

describe("details helpers", () => {
  it("writes the recording date as the admin would type it", () => {
    expect(recordedOnText({ recorded_on: "2001-05-01", recorded_on_precision: "month" })).toBe(
      "2001-05",
    );
    expect(recordedOnText({ recorded_on: "2001-01-01", recorded_on_precision: "year" })).toBe(
      "2001",
    );
    expect(recordedOnText({ recorded_on: "2001-05-28", recorded_on_precision: null })).toBe(
      "2001-05-28",
    );
    expect(recordedOnText({ recorded_on: null, recorded_on_precision: null })).toBe("");
  });

  it("says what the detected language is", () => {
    expect(detectedLabel(detail)).toBe("Use the detected language (Nepali, 92% of the speech)");
    expect(detectedLabel({ language_detected: "xx", language_detected_confidence: null })).toBe(
      "Use the detected language (xx)",
    );
    expect(detectedLabel({ language_detected: null, language_detected_confidence: null })).toBe(
      "Detect from the audio (not detected yet)",
    );
  });

  it("sends only what changed", () => {
    expect(changedFields(detail, unchanged)).toEqual({});
    expect(
      changedFields(detail, {
        title: " New title ",
        interviewee: { id: null, name: "" },
        recordedOn: "",
        language: "new",
      }),
    ).toEqual({ title: "New title", interviewee_id: null, recorded_on: null, language: "new" });
    expect(changedFields(detail, { ...unchanged, interviewee: { id: 9, name: "Other" } })).toEqual({
      interviewee_id: 9,
    });
    // A typed name adds a person, unless it's the current one's name.
    expect(changedFields(detail, { ...unchanged, interviewee: { id: null, name: "X" } })).toEqual({
      interviewee_name: "X",
    });
    expect(
      changedFields(detail, { ...unchanged, interviewee: { id: null, name: "Interviewee B" } }),
    ).toEqual({});
    expect(
      changedFields({ ...detail, language_confirmed: "new" }, { ...unchanged, language: "" }),
    ).toEqual({ language: null });
  });
});

describe("edit details dialog", () => {
  it("saves the corrected language and details, and reports a failed save", async () => {
    const path = `/api/interviews/${detail.id}`;
    const routes = {
      "/api/auth/me": { body: { id: 1, email: "someone@example.org" } },
      "/api/search/filters": { body: { languages: [], interviewees: [] } },
      [path]: { body: detail },
      [`${path}/jobs`]: { body: { items: [] } },
      [`${path}/transcript`]: { body: { items: [] } },
    };
    stubApi(routes);
    renderApp(`/admin/interviews/${detail.id}`, fakeAuthClient({ signedIn: true }));

    expect(await screen.findByText("Nepali (detected)", {}, SLOW)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Edit details" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit details" });
    const title = within(dialog).getByRole("textbox", { name: /Interview title/ });
    await userEvent.clear(title);
    await userEvent.type(title, "Corrected title");
    await userEvent.click(within(dialog).getByRole("combobox", { name: "Original language" }));
    await userEvent.click(await screen.findByRole("option", { name: "Nepal Bhasa" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await vi.waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    const patch = vi
      .mocked(fetch)
      .mock.calls.find(([url, init]) => url === path && init?.method === "PATCH");
    expect(patch?.[1]?.body).toBe('{"title":"Corrected title","language":"new"}');

    // A refused save keeps the dialog open with a message.
    stubApi({ ...routes, [path]: { status: 500, body: {} } });
    await userEvent.click(screen.getByRole("button", { name: "Edit details" }));
    const again = await screen.findByRole("dialog", { name: "Edit details" });
    await userEvent.clear(within(again).getByRole("textbox", { name: /Recording date/ }));
    await userEvent.click(within(again).getByRole("button", { name: "Save" }));
    expect(
      await within(again).findByText("The details couldn't be saved. Try again."),
    ).toBeTruthy();
    await userEvent.click(within(again).getByRole("button", { name: "Cancel" }));
    await vi.waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });
});
