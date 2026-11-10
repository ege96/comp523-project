import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { InterviewDetail, Job } from "../api/schemas";
import { interviewDetail } from "../test/fixtures";
import { fakeAuthClient, renderApp, stubApi } from "../test/renderApp";
import { languageMismatch, retryableJobs, retryStepFor } from "./rerun";

const SLOW = { timeout: 5000 };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function job(kind: string, state: Job["state"], last_error: string | null = null): Job {
  return {
    kind,
    state,
    attempts: state === "failed" ? 3 : 1,
    max_attempts: 3,
    last_error,
    created_at: "2026-10-14T00:00:00Z",
    finished_at: null,
  };
}

describe("rerun helpers", () => {
  it("maps each job to the step that redoes it", () => {
    expect(retryStepFor("retranscribe")).toBe("transcribe");
    expect(retryStepFor("retranslate")).toBe("retranslate");
    expect(retryStepFor("playback")).toBe("playback");
    expect(retryStepFor("something-new")).toBeNull();
  });

  it("offers Retry only on a step's latest job, when it failed", () => {
    const oldFailure = job("translate", "failed");
    const retried = job("translate", "done");
    const playback = job("playback", "failed");
    const retranscribe = job("retranscribe", "failed");
    const jobs = [job("transcribe", "failed"), retranscribe, oldFailure, retried, playback];
    expect(retryableJobs(jobs)).toEqual(new Set([retranscribe, playback]));
  });

  it("notices lines made in another language than the corrected one", () => {
    const ne = { code: "ne", name: "Nepali" };
    const en = { code: "en", name: "English" };
    const newari = { code: "new", name: "Nepal Bhasa" };
    expect(languageMismatch({ language_confirmed: "new", languages: [ne, newari, en] })).toBe(
      "Nepal Bhasa",
    );
    expect(languageMismatch({ language_confirmed: "new", languages: [newari, en] })).toBeNull();
    expect(languageMismatch({ language_confirmed: null, languages: [ne] })).toBeNull();
    expect(languageMismatch({ language_confirmed: "en", languages: [ne] })).toBeNull();
  });
});

describe("re-running steps on the admin page", () => {
  const detail: InterviewDetail = {
    ...interviewDetail,
    visibility: "private",
    primary_language: { code: "new", name: "Nepal Bhasa" },
    language_confirmed: "new",
    languages: [
      { code: "ne", name: "Nepali" },
      { code: "new", name: "Nepal Bhasa" },
    ],
    translation_status: "failed",
  };
  const path = `/api/interviews/${detail.id}`;

  function posts() {
    return vi
      .mocked(fetch)
      .mock.calls.filter(([url, init]) => url === `${path}/rerun` && init?.method === "POST")
      .map(([, init]) => init?.body);
  }

  it("retries a failed step, and warns before transcribing over corrections", async () => {
    const routes: Parameters<typeof stubApi>[0] = {
      "/api/auth/me": { body: { id: 1, email: "someone@example.org" } },
      "/api/search/filters": { body: { languages: [], interviewees: [] } },
      [path]: { body: detail },
      [`${path}/jobs`]: {
        body: { items: [job("transcribe", "done"), job("translate", "failed", "quota")] },
      },
      [`${path}/transcript`]: { body: { items: [] } },
      [`${path}/rerun`]: { status: 204, body: null },
    };
    stubApi(routes);
    renderApp(`/admin/interviews/${detail.id}`, fakeAuthClient({ signedIn: true }));

    expect(
      await screen.findByText(/The language was set to Nepal Bhasa after/, {}, SLOW),
    ).toBeTruthy();
    expect(screen.getByText(/The English translation didn't work/)).toBeTruthy();
    const steps = await screen.findByRole("list", { name: "Processing steps" });
    expect(within(steps).getAllByRole("button", { name: "Retry processing" })).toHaveLength(1);
    await userEvent.click(within(steps).getByRole("button", { name: "Retry processing" }));
    await vi.waitFor(() => {
      expect(posts()).toEqual(['{"step":"translate","replace_corrections":false}']);
    });

    // Lines have corrections: the API refuses until the admin confirms.
    routes[`${path}/rerun`] = {
      status: 409,
      body: { detail: { message: "would replace", corrected_lines: 2 } },
    };
    await userEvent.click(screen.getByRole("button", { name: "Transcribe again" }));
    const dialog = await screen.findByRole("dialog", { name: "Transcribe again in Nepal Bhasa?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Transcribe again" }));
    expect(await within(dialog).findByText(/2 lines have corrections/)).toBeTruthy();

    routes[`${path}/rerun`] = { status: 204, body: null };
    await userEvent.click(within(dialog).getByRole("button", { name: "Replace corrections" }));
    await vi.waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(posts().slice(1)).toEqual([
      '{"step":"transcribe","replace_corrections":false}',
      '{"step":"transcribe","replace_corrections":true}',
    ]);

    routes[`${path}/rerun`] = { status: 500, body: {} };
    await userEvent.click(screen.getByRole("button", { name: "Translate again" }));
    expect(await screen.findByText("That step couldn't be started. Try again.")).toBeTruthy();
    await userEvent.click(within(steps).getByRole("button", { name: "Retry processing" }));
    expect(await within(steps).findByRole("alert")).toHaveProperty(
      "textContent",
      "That didn't start. Check your connection and try again.",
    );
  });
});
