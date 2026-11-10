import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

import { interviewDetail, interviewSummary } from "../test/fixtures";
import { fakeAuthClient, renderApp, stubApi } from "../test/renderApp";

// The tus upload itself is covered in upload.test.ts; here it resolves when the test says.
type FakeUpload = {
  start: Mock;
  abort: Mock;
  finish: (interviewId: string) => void;
  fail: (error: Error) => void;
};
const upload = vi.hoisted((): FakeUpload => ({
  start: vi.fn(),
  abort: vi.fn(),
  finish: () => {},
  fail: () => {},
}));
vi.mock("./upload", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./upload")>()),
  startUpload: upload.start.mockImplementation(() => ({
    done: new Promise<string>((resolve, reject) => {
      upload.finish = resolve;
      upload.fail = reject;
    }),
    abort: upload.abort,
  })),
}));

// The admin pages load on demand, which can be slow on a busy CI runner.
const SLOW = { timeout: 5000 };

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  upload.start.mockClear();
  upload.abort.mockClear();
});

const id = interviewSummary.id;
const privateOne = {
  ...interviewSummary,
  id: "00000000-0000-4000-8000-000000000002",
  title: "Test interview B",
  visibility: "private",
  status: "processing",
} as const;
const adminApi = {
  "/api/auth/me": { body: { id: 1, email: "someone@example.org" } },
  "/api/interviews": { body: { items: [interviewSummary, privateOne], total: 2 } },
  "/api/search/filters": { body: { languages: [], interviewees: [{ id: 7, name: "Person F" }] } },
  [`/api/interviews/${privateOne.id}`]: { status: 500, body: {} },
  [`/api/interviews/${id}`]: { body: interviewDetail },
  [`/api/interviews/${id}/jobs`]: { body: { items: [] } },
};

function requests() {
  return vi.mocked(fetch).mock.calls.map(([url, init]) => ({
    url: url as string,
    method: init?.method ?? "GET",
    body: init?.body,
  }));
}

describe("admin page", () => {
  it("lists every recording with its next step, and filters by what to do next", async () => {
    stubApi(adminApi);
    renderApp("/admin", fakeAuthClient({ signedIn: true }));

    // The shared archive, not the admin's own.
    expect(await screen.findByRole("heading", { name: "All interviews" }, SLOW)).toBeTruthy();
    const row = (await screen.findByRole("link", { name: "Test interview B" }, SLOW)).closest("li");
    if (!row) throw new Error("no row");
    expect(within(row).getByText("Processing")).toBeTruthy();
    expect(within(row).getByText("The transcript is being made. Nothing to do yet.")).toBeTruthy();
    expect(
      within(row).getByRole("link", { name: "Check progress: Test interview B" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: `Open: ${interviewSummary.title}` }).closest("li"),
    ).toHaveProperty("textContent", expect.stringContaining("Visitors can find and play it."));

    await userEvent.click(screen.getByRole("tab", { name: /Needs attention/ }));
    await userEvent.click(screen.getByRole("tab", { name: /Not published/ }));
    await userEvent.click(screen.getByRole("tab", { name: /^Published/ }));
    await vi.waitFor(() => {
      expect(requests().some((r) => r.url.includes("limit=20&offset=0&status=failed"))).toBe(true);
      expect(
        requests().some((r) => r.url.includes("limit=20&offset=0&status=done&visibility=private")),
      ).toBe(true);
      // Published means finished too: a Public interview still processing is under Processing.
      expect(
        requests().some((r) => r.url.includes("limit=20&offset=0&status=done&visibility=public")),
      ).toBe(true);
    });
    // Each tab shows how many recordings are waiting in it.
    expect(screen.getByRole("tab", { name: /^Published.*\(2\)$/ })).toBeTruthy();
  });

  it("keeps the view and page in the URL", async () => {
    stubApi({ ...adminApi, "/api/interviews": { body: { items: [], total: 45 } } });
    const router = renderApp("/admin?view=attention&page=2", fakeAuthClient({ signedIn: true }));
    expect(await screen.findByText("Nothing needs your attention.", {}, SLOW)).toBeTruthy();
    expect(requests().some((r) => r.url.includes("limit=20&offset=20&status=failed"))).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Go to page 3" }));
    expect(router.state.location.search).toEqual({ view: "attention", page: 3 });
    await userEvent.click(screen.getByRole("tab", { name: "All" }));
    expect(router.state.location.search).toEqual({});
  });

  it("publishes only after asking, and unpublishes at once", async () => {
    const routes = {
      ...adminApi,
      [`/api/interviews/${id}`]: { body: { ...interviewDetail, visibility: "private" } },
      [`/api/interviews/${id}/transcript`]: {
        body: {
          items: [
            {
              seq: 0,
              start_ms: 0,
              end_ms: 5_000,
              language: "ne",
              original_machine: "Machine line",
              original_edited: "Corrected line",
              english_machine: null,
              english_edited: null,
              edited_at: "2026-11-02T10:00:00Z",
              english_stale: false,
              english_edit_stale: false,
              edited_by: "a@example.org",
            },
          ],
        },
      },
    };
    stubApi(routes);
    renderApp(`/admin/interviews/${id}`, fakeAuthClient({ signedIn: true }));
    // The transcript is on the same page, in a box that scrolls beside the recording.
    expect(await screen.findByText("Corrected line", {}, SLOW)).toBeTruthy();
    expect(screen.getByRole("region", { name: "Transcript lines" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Correct the transcript" })).toHaveProperty(
      "hash",
      "#transcript",
    );

    expect(
      await screen.findByRole("heading", { name: "Finished, not published" }, SLOW),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Publish" }));
    const dialog = await screen.findByRole("dialog", { name: "Publish “Test interview A”?" });
    // It says what visitors get now, from this interview's state, in its description.
    const description = document.getElementById(dialog.getAttribute("aria-describedby") ?? "");
    expect(description?.textContent).toContain("What visitors will get");
    expect(
      within(dialog)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      "Play the recording",
      "Read the transcript, marked as made by machine",
      "No English translation yet",
      "Find it in search",
    ]);
    expect(within(dialog).getByText(/agreed to share it publicly/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(requests().some((r) => r.method === "PATCH")).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: "Publish" }));
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Publish" }),
    );
    expect(requests()).toContainEqual({
      url: `/api/interviews/${id}`,
      method: "PATCH",
      body: '{"visibility":"public"}',
    });

    cleanup();
    stubApi({ ...routes, [`/api/interviews/${id}`]: { body: interviewDetail } });
    renderApp(`/admin/interviews/${id}`, fakeAuthClient({ signedIn: true }));
    expect(await screen.findByRole("heading", { name: "Published" }, SLOW)).toBeTruthy();
    // Correcting stays one click away once published; the preview says why it shows admin notes.
    const nextStep = screen.getByRole("region", { name: "Published" });
    expect(within(nextStep).getByRole("link", { name: "Correct the transcript" })).toHaveProperty(
      "hash",
      "#transcript",
    );
    expect(screen.getByRole("link", { name: "Preview the public page" })).toBeTruthy();
    expect(screen.getByText(/admin-only notes show too/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Unpublish" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(requests()).toContainEqual({
      url: `/api/interviews/${id}`,
      method: "PATCH",
      body: '{"visibility":"private"}',
    });
  });

  it("says when publishing failed", async () => {
    const routes = {
      ...adminApi,
      [`/api/interviews/${privateOne.id}`]: { body: { ...interviewDetail, ...privateOne } },
      [`/api/interviews/${privateOne.id}/jobs`]: { status: 500, body: {} },
      [`/api/interviews/${privateOne.id}/transcript`]: { body: { items: [] } },
    };
    stubApi(routes);
    renderApp(`/admin/interviews/${privateOne.id}`, fakeAuthClient({ signedIn: true }));
    // While processing, publishing is under "Who can see it" (D-008 allows it).
    expect(await screen.findByRole("heading", { name: "Being processed" }, SLOW)).toBeTruthy();
    expect(await screen.findByText("The processing steps couldn't be loaded.")).toBeTruthy();
    stubApi({ ...routes, [`/api/interviews/${privateOne.id}`]: { status: 500, body: {} } });
    await userEvent.click(screen.getByRole("button", { name: "Publish" }));
    const dialog = await screen.findByRole("dialog");
    // Still processing: it doesn't promise a transcript or search yet.
    expect(within(dialog).getByText(/Transcript still being made/)).toBeTruthy();
    expect(within(dialog).getByText("The English translation is still being made")).toBeTruthy();
    expect(within(dialog).getByText("Search finds it once processing finishes")).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Publish" }));
    expect(await screen.findByText("Couldn't publish it. Try again.")).toBeTruthy();
  });

  it("checks the form, then uploads with only the details given", async () => {
    stubApi(adminApi);
    renderApp("/admin", fakeAuthClient({ signedIn: true }));

    const submit = await screen.findByRole("button", { name: "Upload" }, SLOW);
    await userEvent.click(submit);
    const fileError = await screen.findByText("Choose a recording to upload");
    expect(fileError.getAttribute("role")).toBe("alert");
    expect(screen.getByText("Enter a title")).toBeTruthy();
    // The file error belongs to Choose file, which gets the focus as the first problem.
    const choose = screen.getByRole("button", { name: "Choose file" });
    expect(choose.getAttribute("aria-describedby")).toBe(fileError.id);
    expect(screen.getByLabelText("Recording file").getAttribute("aria-describedby")).toBe(
      fileError.id,
    );
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(choose);
    });

    const notes = new File(["x"], "notes.txt", { type: "text/plain" });
    fireEvent.drop(screen.getByText("Drop a video or audio file here"), {
      dataTransfer: { files: [notes] },
    });
    expect(await screen.findByText("Choose an audio or video file")).toBeTruthy();

    const file = new File(["x"], "village-talk.mp3", { type: "audio/mpeg" });
    await userEvent.upload(screen.getByLabelText("Recording file"), file);
    expect(screen.getByRole("textbox", { name: /Interview title/ })).toHaveProperty(
      "value",
      "village-talk",
    );
    const person = screen.getByRole("combobox", { name: "Interviewee" });
    await userEvent.type(person, "New person");
    expect(screen.getByText("A new interviewee will be added")).toBeTruthy();
    await userEvent.clear(person);
    await userEvent.type(person, "Pers");
    await userEvent.click(await screen.findByRole("option", { name: "Person F" }));
    expect(screen.getByText("An existing interviewee")).toBeTruthy();
    await userEvent.click(screen.getByRole("combobox", { name: "Original language" }));
    await userEvent.click(await screen.findByRole("option", { name: "Nepal Bhasa" }));
    const pick = async (field: string, option: string) => {
      await userEvent.click(screen.getByRole("combobox", { name: field }));
      await userEvent.click(await screen.findByRole("option", { name: option }));
    };
    const year = screen.getByRole("textbox", { name: "Year" });
    await pick("Month", "February");
    await userEvent.click(submit);
    expect(await screen.findByText("Add the year too, or leave the month empty")).toBeTruthy();
    await userEvent.type(year, "2023");
    await pick("Day", "29");
    await userEvent.click(submit);
    expect(await screen.findByText("February 2023 has no day 29")).toBeTruthy();
    expect(upload.start).not.toHaveBeenCalled();

    await pick("Day", "Not known");
    await userEvent.clear(year);
    await userEvent.type(year, "2019");
    await pick("Month", "May");
    await userEvent.click(submit);
    expect(upload.start).toHaveBeenCalledWith(
      file,
      {
        title: "village-talk",
        language: "new",
        intervieweeId: 7,
        intervieweeName: undefined,
        recordedOn: "2019-05",
      },
      expect.anything(),
    );
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(upload.abort).toHaveBeenCalled();
    expect(screen.queryByText(/Keep this page open/)).toBeNull();

    // A failed attempt keeps the form filled in, so Upload retries (and resumes).
    await userEvent.click(submit);
    upload.fail(new Error("offline"));
    expect(await screen.findByText(/connection to the archive was lost/)).toBeTruthy();
    await userEvent.click(submit);
    upload.finish(id);
    await userEvent.click(await screen.findByRole("link", { name: "Follow its progress" }));
    expect(await screen.findByText("Nothing has started yet.")).toBeTruthy();
  });

  it("asks before leaving the page during an upload, and stops it on leaving", async () => {
    stubApi(adminApi);
    const router = renderApp("/admin", fakeAuthClient({ signedIn: true }));
    const submit = await screen.findByRole("button", { name: "Upload" }, SLOW);
    const file = new File(["x"], "village-talk.mp3", { type: "audio/mpeg" });
    await userEvent.upload(screen.getByLabelText("Recording file"), file);
    await userEvent.click(submit);
    expect(await screen.findByText(/Keep this page open/)).toBeTruthy();

    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    const about = within(screen.getByRole("contentinfo")).getByRole("link", {
      name: "About & Help",
    });
    await userEvent.click(about);
    expect(confirm).toHaveBeenCalledWith("Leave this page? The upload will stop.");
    expect(router.state.location.pathname).toBe("/admin");
    expect(upload.abort).not.toHaveBeenCalled();
    // Another tab of the list is the same page, so it doesn't ask.
    await userEvent.click(screen.getByRole("tab", { name: /Needs attention/ }));
    expect(router.state.location.search).toEqual({ view: "attention" });
    expect(confirm).toHaveBeenCalledTimes(1);

    confirm.mockReturnValue(true);
    await userEvent.click(about);
    expect(await screen.findByRole("heading", { level: 1, name: "About & Help" })).toBeTruthy();
    expect(upload.abort).toHaveBeenCalled();
  });

  it("shows a stopped recording's problem, its steps and the technical details", async () => {
    stubApi({
      ...adminApi,
      [`/api/interviews/${id}`]: {
        body: {
          ...interviewDetail,
          interviewee: null,
          primary_language: null,
          duration_ms: null,
          visibility: "private",
          status: "failed",
          status_detail: "Playback copy failed",
        },
      },
      [`/api/interviews/${id}/transcript`]: { body: { items: [] } },
      [`/api/interviews/${id}/jobs`]: {
        body: {
          items: [
            {
              kind: "playback",
              state: "failed",
              attempts: 3,
              max_attempts: 3,
              last_error: "ffmpeg exited 1",
              created_at: "2026-10-14T00:00:00Z",
              finished_at: "2026-10-14T00:10:00Z",
            },
          ],
        },
      },
    });
    renderApp(`/admin/interviews/${id}`, fakeAuthClient({ signedIn: true }));

    expect(await screen.findByRole("heading", { name: "Processing stopped" }, SLOW)).toBeTruthy();
    expect(screen.getByText("Playback copy failed")).toBeTruthy();
    expect(screen.getByText("Not detected yet")).toBeTruthy();
    expect(screen.getByText("14 October 2026")).toBeTruthy();
    expect(screen.getByText("Private: only admins can see it")).toBeTruthy();
    const steps = await screen.findByRole("list", { name: "Processing steps" });
    expect(within(steps).getByText("Getting the audio ready to play")).toBeTruthy();
    expect(within(steps).getByText("Tried 3 times.")).toBeTruthy();
    // The retry is the next step's button, not repeated in the list.
    expect(within(steps).queryByRole("button", { name: "Retry processing" })).toBeNull();
    expect(screen.getByRole("button", { name: "Retry processing" })).toBeTruthy();
    // The file couldn't be read, so a converted upload is offered beside the retry.
    expect(screen.getByRole("link", { name: "Upload a converted file" }).getAttribute("href")).toBe(
      "/admin#add-interview",
    );
    expect(within(steps).queryByText("ffmpeg exited 1")).toBeNull(); // folded away
    await userEvent.click(within(steps).getByRole("button", { name: "Show technical details" }));
    expect(within(steps).getByText("ffmpeg exited 1")).toBeTruthy();
    // Publishing a stopped interview says what visitors would miss.
    await userEvent.click(screen.getByRole("button", { name: "Publish" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      "Play the recording",
      "No transcript (marked “Transcript unavailable”)",
      "No English translation yet",
      "Search won't find it until processing works",
    ]);

    // A re-index (e.g. after a search model change) runs while the interview stays published.
    cleanup();
    stubApi({
      ...adminApi,
      [`/api/interviews/${id}/transcript`]: { body: { items: [] } },
      [`/api/interviews/${id}/jobs`]: {
        body: {
          items: [
            {
              kind: "index",
              state: "running",
              attempts: 1,
              max_attempts: 3,
              last_error: null,
              created_at: "2026-11-04T00:00:00Z",
              finished_at: null,
            },
          ],
        },
      },
    });
    renderApp(`/admin/interviews/${id}`, fakeAuthClient({ signedIn: true }));
    expect(await screen.findByRole("heading", { name: "Published" }, SLOW)).toBeTruthy();
    expect(await screen.findByText(/Search is being updated for this interview/)).toBeTruthy();
    const indexing = await screen.findByRole("list", { name: "Processing steps" });
    expect(within(indexing).getByText("Making it searchable")).toBeTruthy();

    // Once every step is done, the checklist folds into one line.
    cleanup();
    const done = (kind: string) => ({
      kind,
      state: "done",
      attempts: 1,
      max_attempts: 3,
      last_error: null,
      created_at: "2026-11-04T00:00:00Z",
      finished_at: "2026-11-04T00:10:00Z",
    });
    stubApi({
      ...adminApi,
      [`/api/interviews/${id}/transcript`]: { body: { items: [] } },
      [`/api/interviews/${id}/jobs`]: { body: { items: [done("playback"), done("index")] } },
    });
    renderApp(`/admin/interviews/${id}`, fakeAuthClient({ signedIn: true }));
    expect(await screen.findByText("All steps finished", {}, SLOW)).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Processing steps" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Show steps" }));
    expect(screen.getByRole("list", { name: "Processing steps" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hide steps" })).toHaveProperty(
      "ariaExpanded",
      "true",
    );

    cleanup();
    renderApp("/admin/interviews/missing", fakeAuthClient({ signedIn: true }));
    expect(await screen.findByText("This interview doesn't exist.")).toBeTruthy();
  });
});
