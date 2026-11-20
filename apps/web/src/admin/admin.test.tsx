import {
  cleanup,
  fireEvent,
  screen,
  waitForElementToBeRemoved,
  within,
} from "@testing-library/react";
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
      "Find it in search by its title and details",
      "Find moments in search by the words said",
      "Find moments in search by meaning",
    ]);
    expect(within(dialog).getByText(/agreed to share it publicly/)).toBeTruthy();
    // The closing dialog stays in the document for its exit transition: wait until it's gone,
    // so the next Publish found is the page's button and not the one in that dialog.
    const closed = waitForElementToBeRemoved(dialog);
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await closed;
    expect(requests().some((r) => r.method === "PATCH")).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: "Publish" }));
    const again = await screen.findByRole("dialog", { name: "Publish “Test interview A”?" });
    await userEvent.click(within(again).getByRole("button", { name: "Publish" }));
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
    // While processing, publishing is under "Who can see it".
    expect(await screen.findByRole("heading", { name: "Being processed" }, SLOW)).toBeTruthy();
    expect(await screen.findByText("The processing steps couldn't be loaded.")).toBeTruthy();
    stubApi({ ...routes, [`/api/interviews/${privateOne.id}`]: { status: 500, body: {} } });
    await userEvent.click(screen.getByRole("button", { name: "Publish" }));
    const dialog = await screen.findByRole("dialog");
    // Still processing: it doesn't promise a transcript or search yet.
    expect(within(dialog).getByText(/Transcript still being made/)).toBeTruthy();
    expect(within(dialog).getByText("The English translation is still being made")).toBeTruthy();
    expect(
      within(dialog).getByText("Search finds what is said once the transcript is made"),
    ).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Publish" }));
    expect(await screen.findByText("Couldn't publish it. Try again.")).toBeTruthy();
  });

  // Opens the admin page and returns its Upload button.
  async function openUploadForm(storage = { usable_bytes: 10_000, max_upload_bytes: 5_000 }) {
    stubApi({ ...adminApi, "/api/storage": { body: storage } });
    renderApp("/admin", fakeAuthClient({ signedIn: true }));
    return screen.findByRole("button", { name: "Upload" }, SLOW);
  }
  const recording = (name = "village-talk.mp3", size = 1) =>
    new File(["x".repeat(size)], name, { type: "audio/mpeg" });
  const pick = async (field: string, option: string, scope: HTMLElement = document.body) => {
    await userEvent.click(within(scope).getByRole("combobox", { name: field }));
    await userEvent.click(await screen.findByRole("option", { name: option }));
  };
  const row = (name: string) => screen.getByRole("group", { name });
  const addFiles = (...files: File[]) =>
    userEvent.upload(screen.getByLabelText("Recording files"), files);

  it("points to the missing files first when the form is empty", async () => {
    await userEvent.click(await openUploadForm());
    const fileError = await screen.findByText("Choose a recording to upload");
    expect(fileError.getAttribute("role")).toBe("alert");
    const choose = screen.getByRole("button", { name: "Choose files" });
    expect(choose.getAttribute("aria-describedby")).toBe(fileError.id);
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(choose);
    });
  });

  it("makes a row per recording, skipping other files and repeats, and fills shared details", async () => {
    await openUploadForm();
    const talk = recording();
    const notes = new File(["x"], "notes.txt", { type: "text/plain" });
    fireEvent.drop(screen.getByText(/Drop video or audio files/), {
      dataTransfer: { files: [talk, notes, recording("dawn.m4a")] },
    });
    expect(await screen.findByText(/Skipped notes.txt: not audio or video/)).toBeTruthy();
    await addFiles(talk);
    expect(await screen.findByText(/village-talk.mp3 already in the list/)).toBeTruthy();
    expect(
      within(row("dawn.m4a")).getByRole("textbox", { name: /Interview title/ }),
    ).toHaveProperty("value", "dawn");

    // One recording has its own language; the shared details fill only what's empty.
    await userEvent.click(
      within(row("dawn.m4a")).getByRole("button", { name: /language and date/ }),
    );
    await pick("Original language", "English", row("dawn.m4a"));
    await userEvent.click(screen.getByRole("button", { name: "Same details for all recordings" }));
    const shared = screen.getByRole("group", { name: "Same details for all recordings" });
    await userEvent.type(within(shared).getByRole("combobox", { name: "Interviewee" }), "Pers");
    await userEvent.click(await screen.findByRole("option", { name: "Person F" }));
    await pick("Original language", "Nepali", shared);
    await userEvent.click(screen.getByRole("button", { name: "Fill in all recordings" }));

    await userEvent.click(screen.getByRole("button", { name: "Upload 2 recordings" }));
    expect(upload.start).toHaveBeenCalledWith(
      talk,
      {
        title: "village-talk",
        language: "ne",
        intervieweeId: 7,
        intervieweeName: undefined,
        recordedOn: undefined,
      },
      expect.anything(),
    );
    upload.finish(id);
    await vi.waitFor(() => {
      expect(upload.start).toHaveBeenCalledTimes(2);
    });
    expect(upload.start.mock.calls[1]?.[1]).toMatchObject({
      title: "dawn",
      language: "en",
      intervieweeId: 7,
    });
  });

  it("refuses a recording date that can't be right, unfolding the row it's in", async () => {
    await openUploadForm();
    await addFiles(recording(), recording("dawn.m4a"));
    const dawn = row("dawn.m4a");
    await userEvent.click(within(dawn).getByRole("button", { name: /language and date/ }));
    await pick("Month", "February", dawn);
    await userEvent.click(within(dawn).getByRole("button", { name: "Hide other details" }));
    await userEvent.click(screen.getByRole("button", { name: "Upload 2 recordings" }));
    expect(await screen.findByText("Add the year too, or leave the month empty")).toBeTruthy();
    expect(within(dawn).getByRole("button", { name: "Hide other details" })).toBeTruthy();
    expect(upload.start).not.toHaveBeenCalled();
  });

  it("sends the files one by one, carries on past a failure, and retries it", async () => {
    await openUploadForm();
    await addFiles(recording(), recording("dawn.m4a"));
    await userEvent.click(screen.getByRole("button", { name: "Upload 2 recordings" }));
    expect(within(row("dawn.m4a")).getByText("Waiting to upload")).toBeTruthy();
    expect(await screen.findByText(/Keep this page open/)).toBeTruthy();
    upload.fail(new Error("offline"));
    expect(
      await within(row("village-talk.mp3")).findByText(/connection to the archive was lost/),
    ).toBeTruthy();
    await vi.waitFor(() => {
      expect(upload.start).toHaveBeenCalledTimes(2);
    });
    upload.finish(id);
    expect(
      await within(row("dawn.m4a")).findByRole("link", { name: "Follow its progress" }),
    ).toBeTruthy();

    await userEvent.click(within(row("village-talk.mp3")).getByRole("button", { name: "Retry" }));
    await vi.waitFor(() => {
      expect(upload.start).toHaveBeenCalledTimes(3);
    });
    upload.finish(id);
    await userEvent.click(await screen.findByRole("button", { name: "Clear finished" }));
    expect(screen.queryByRole("group", { name: "dawn.m4a" })).toBeNull();
  });

  it("stops the upload, keeping the rest to send later", async () => {
    await openUploadForm();
    await addFiles(recording(), recording("dawn.m4a"));
    await userEvent.click(screen.getByRole("button", { name: "Upload 2 recordings" }));
    await userEvent.click(await screen.findByRole("button", { name: "Stop" }));
    expect(upload.abort).toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "Upload 2 recordings" })).toBeTruthy();
    expect(upload.start).toHaveBeenCalledTimes(1);
  });

  it("warns when a batch won't fit and flags a file over the size limit", async () => {
    await openUploadForm({ usable_bytes: 6_000, max_upload_bytes: 5_000 });
    await addFiles(recording("big.mp3", 5_001), recording("dawn.m4a", 2_000));
    expect(await screen.findByText(/but only .* of space is left/)).toBeTruthy();
    expect(within(row("big.mp3")).getByText(/larger than the .* limit/)).toBeTruthy();
    await userEvent.click(within(row("big.mp3")).getByRole("button", { name: "Remove big.mp3" }));
    expect(await screen.findByText(/to upload · .* of space left/)).toBeTruthy();
  });

  it("asks before leaving the page during an upload, and stops it on leaving", async () => {
    stubApi(adminApi);
    const router = renderApp("/admin", fakeAuthClient({ signedIn: true }));
    const submit = await screen.findByRole("button", { name: "Upload" }, SLOW);
    await addFiles(recording());
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
      "Find it in search by its title and details",
      "Search can't find what is said without a transcript",
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
