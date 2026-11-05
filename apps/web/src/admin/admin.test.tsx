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
  it("lists every interview with its status, filters by status and publishes", async () => {
    stubApi(adminApi);
    renderApp("/admin", fakeAuthClient({ signedIn: true }));

    const row = (await screen.findByRole("link", { name: "Test interview B" }, SLOW)).closest("li");
    if (!row) throw new Error("no row");
    expect(within(row).getByText("Processing")).toBeTruthy();
    expect(screen.getByText("Done", { selector: ".MuiChip-label" })).toBeTruthy();

    await userEvent.click(within(row).getByRole("switch", { name: "Public: Test interview B" }));
    expect(requests()).toContainEqual({
      url: `/api/interviews/${privateOne.id}`,
      method: "PATCH",
      body: '{"visibility":"public"}',
    });
    expect(await within(row).findByRole("alert")).toHaveProperty(
      "textContent",
      "Couldn't change visibility. Try again.",
    );

    await userEvent.click(screen.getByRole("tab", { name: "Failed" }));
    await vi.waitFor(() => {
      expect(requests().some((r) => r.url.includes("status=failed"))).toBe(true);
    });
  });

  it("keeps the status filter and page in the URL", async () => {
    stubApi({ ...adminApi, "/api/interviews": { body: { items: [], total: 45 } } });
    const router = renderApp("/admin?status=failed&page=2", fakeAuthClient({ signedIn: true }));
    expect(await screen.findByText("No interviews are failed.", {}, SLOW)).toBeTruthy();
    expect(requests().some((r) => r.url.includes("limit=20&offset=20&status=failed"))).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Go to page 3" }));
    await userEvent.click(screen.getByRole("tab", { name: "All" }));
    expect(router.state.location.search).toEqual({});
  });

  it("checks the form, then uploads with only the details given", async () => {
    stubApi(adminApi);
    renderApp("/admin", fakeAuthClient({ signedIn: true }));

    const submit = await screen.findByRole("button", { name: "Upload" }, SLOW);
    await userEvent.click(submit);
    expect(await screen.findByText("Choose a recording to upload")).toBeTruthy();
    expect(screen.getByText("Enter a title")).toBeTruthy();

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
    const date = screen.getByRole("textbox", { name: "Recording date" });
    await userEvent.type(date, "2023-02-29");
    await userEvent.click(submit);
    expect(await screen.findByText(/Use YYYY, YYYY-MM or YYYY-MM-DD/)).toBeTruthy();
    expect(upload.start).not.toHaveBeenCalled();

    await userEvent.clear(date);
    await userEvent.type(date, "2019-05");
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
    expect(await screen.findByText("No steps have been queued yet.")).toBeTruthy();
  });

  it("shows one interview's status, steps and errors", async () => {
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

    expect(await screen.findByText("Playback copy failed", {}, SLOW)).toBeTruthy();
    expect(screen.getByText("Not detected yet")).toBeTruthy();
    expect(screen.getByText(/Only admins can see this interview/)).toBeTruthy();
    const steps = await screen.findByRole("table", { name: "Processing steps" });
    expect(within(steps).getByText("Playback copy")).toBeTruthy();
    expect(within(steps).getByText("3 of 3")).toBeTruthy();
    expect(within(steps).queryByText("ffmpeg exited 1")).toBeNull(); // folded away
    await userEvent.click(within(steps).getByRole("button", { name: "Show technical details" }));
    expect(within(steps).getByText("ffmpeg exited 1")).toBeTruthy();

    cleanup();
    renderApp("/admin/interviews/missing", fakeAuthClient({ signedIn: true }));
    expect(await screen.findByText("This interview doesn't exist.")).toBeTruthy();
  });
});
