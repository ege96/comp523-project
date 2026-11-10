import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { interviewDetail, interviewSummary, segments } from "../test/fixtures";
import { renderApp, stubApi } from "../test/renderApp";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const id = interviewSummary.id;
const detailPath = `/api/interviews/${id}`;
const segmentsPath = `/api/interviews/${id}/segments`;
const line = (seq: number, original: string, english: string | null, extra = {}) => ({
  ...segments.items[0],
  seq,
  start_ms: seq * 10_000,
  end_ms: seq * 10_000 + 10_000,
  original_text: original,
  english_text: english,
  ...extra,
});
const audio = () => document.querySelector("audio") as HTMLAudioElement;
const detailCalls = () => vi.mocked(fetch).mock.calls.filter(([url]) => url === detailPath).length;

describe("interview viewer: transcript views", () => {
  it("uses full tab names on wider screens and ties the tabs to a named panel", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
    }));
    stubApi({
      [detailPath]: { body: { ...interviewDetail, translation_status: "done" } },
      [segmentsPath]: { body: { items: [line(0, "Original text A", "English text A")] } },
    });
    renderApp(`/interviews/${id}`);
    const tabs = within(await screen.findByRole("tablist", { name: "Transcript language" }));
    const both = tabs.getByRole("tab", { name: "Original + English" });
    expect(tabs.getByRole("tab", { name: "English translation" })).toBeTruthy();
    expect(both.getAttribute("aria-controls")).toBe("transcript-panel");
    const panel = screen.getByRole("tabpanel");
    expect(panel.getAttribute("aria-labelledby")).toBe(both.id);
    expect(within(panel).getByText("Original text A")).toBeTruthy();
  });

  it("labels lines with no English, notes partial English and marks the corrected half", async () => {
    stubApi({
      [detailPath]: { body: interviewDetail }, // translation still pending
      [segmentsPath]: {
        body: {
          items: [
            line(0, "Original text A", "English text A", { english_edited: true }),
            line(1, "Original text B", null, { original_edited: true }),
          ],
        },
      },
    });
    renderApp(`/interviews/${id}`);
    // Some English already: the Both view is offered even though translation isn't done.
    await screen.findByRole("tab", { name: "Both" });
    expect(screen.getByRole("tab", { name: "Original" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.queryByText(/some lines only/)).toBeNull();

    await userEvent.click(screen.getByRole("tab", { name: "English" }));
    expect(screen.getByText(/English is available for some lines only/)).toBeTruthy();
    expect(screen.getByText("English text A")).toBeTruthy();
    const missing = screen.getByText("No English for this line");
    // The original stands in, marked as the original's language.
    expect(missing.closest("p")?.getAttribute("lang")).toBe("ne");
    expect(within(missing.closest("p") as HTMLElement).getByText("Original text B")).toBeTruthy();
    expect(
      screen.getByText("Searches the English text shown (the original where a line has none)"),
    );

    await userEvent.click(screen.getByRole("tab", { name: "Both" }));
    const marks = screen.getAllByText("Corrected");
    expect(marks).toHaveLength(2);
    // Each "Corrected" sits with the half that was edited.
    expect(marks[0]?.closest("p")?.getAttribute("lang")).toBe("en");
    expect(marks[1]?.closest("p")?.getAttribute("lang")).toBe("ne");
    expect(screen.getByText("Searches the original and the English")).toBeTruthy();
    await userEvent.click(screen.getByRole("tab", { name: "Original" }));
    expect(screen.getByText("Searches the original text shown")).toBeTruthy();
    expect(screen.getAllByText("Corrected")).toHaveLength(1);
  });
});

describe("interview viewer: playback", () => {
  it("says a recording is still being prepared only while processing", async () => {
    stubApi({
      [detailPath]: { body: { ...interviewDetail, status: "processing", media: null } },
      [segmentsPath]: { body: segments },
    });
    renderApp(`/interviews/${id}`);
    expect(await screen.findByText("The recording is still being prepared for playback.")).toBe(
      screen.getByText("The recording is still being prepared for playback."),
    );
  });

  it("without a recording, a line's time points at the line instead of playing", async () => {
    stubApi({
      [detailPath]: { body: { ...interviewDetail, status: "failed", media: null } },
      [segmentsPath]: { body: { items: [line(0, "Line zero", null), line(1, "Line one", null)] } },
    });
    const router = renderApp(`/interviews/${id}`);
    expect(await screen.findByText("The recording isn't available to play.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Play from/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Select the line at 0:10" }));
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ t: 10_000 });
    });
    expect(screen.getByText("Line one").closest("li")?.getAttribute("aria-current")).toBe("true");
  });

  it("offers a retry with a fresh link when the recording can't be played", async () => {
    stubApi({ [detailPath]: { body: interviewDetail }, [segmentsPath]: { body: segments } });
    renderApp(`/interviews/${id}?t=754000`);
    await screen.findByText("Original text A");
    const before = audio();
    before.currentTime = 760;
    fireEvent.seeked(before);
    fireEvent.error(before);
    const alert = await screen.findByText("The recording couldn't be played.");
    expect(alert).toBeTruthy();
    const calls = detailCalls();
    await userEvent.click(screen.getByRole("button", { name: "Retry playback" }));
    await waitFor(() => {
      expect(screen.queryByText("The recording couldn't be played.")).toBeNull();
    });
    expect(detailCalls()).toBe(calls + 1);
    // A new element, picking up where playback was.
    expect(audio()).not.toBe(before);
    expect(audio().getAttribute("src")).toBe("/api/media/m1?sig=x#t=760");
  });

  it("reports a play() failure that isn't the browser refusing autoplay", async () => {
    stubApi({ [detailPath]: { body: interviewDetail }, [segmentsPath]: { body: segments } });
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockRejectedValueOnce(new DOMException("blocked", "NotAllowedError"))
      .mockRejectedValueOnce(new DOMException("bad", "NotSupportedError"));
    renderApp(`/interviews/${id}`);
    const time = await screen.findByRole("button", { name: "Play from 12:34" });
    await userEvent.click(time);
    await waitFor(() => {
      expect(play).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByText("The recording couldn't be played.")).toBeNull();
    await userEvent.click(time);
    expect(await screen.findByText("The recording couldn't be played.")).toBeTruthy();
  });

  it("moves the current line when the paused recording is moved", async () => {
    stubApi({
      [detailPath]: { body: interviewDetail },
      [segmentsPath]: { body: { items: [line(0, "Line zero", null), line(1, "Line one", null)] } },
    });
    renderApp(`/interviews/${id}`);
    await screen.findByText("Line one");
    expect(document.querySelector("li[aria-current]")).toBeNull();
    // Paused: a time update alone (as on load) doesn't move the marker; a seek does.
    audio().currentTime = 12;
    fireEvent.timeUpdate(audio());
    expect(document.querySelector("li[aria-current]")).toBeNull();
    fireEvent.seeked(audio());
    expect(screen.getByText("Line one").closest("li")?.getAttribute("aria-current")).toBe("true");
  });

  it("builds caption tracks for a video from the transcript, and frees them", async () => {
    const create = vi.fn((blob: Blob) => (blob.size ? "blob:captions" : ""));
    const revoke = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
    stubApi({
      [detailPath]: {
        body: {
          ...interviewDetail,
          media: { ...interviewDetail.media, content_type: "video/mp4" },
        },
      },
      [segmentsPath]: {
        body: { items: [line(0, "Line zero", "English zero"), line(1, "Line one", null)] },
      },
    });
    renderApp(`/interviews/${id}`);
    await screen.findByText("Line one");
    const video = document.querySelector("video") as HTMLVideoElement;
    expect(video.hasAttribute("playsinline")).toBe(true);
    const tracks = [...video.querySelectorAll("track")];
    expect(tracks.map((t) => [t.label, t.srclang, t.default])).toEqual([
      ["Original (machine transcript)", "ne", true],
      ["English (machine translation)", "en", false],
    ]);
    await waitFor(() => {
      expect(tracks[0]?.getAttribute("src")).toBe("blob:captions");
    });
    const blob = create.mock.calls[0]?.[0];
    expect(blob?.type).toBe("text/vtt");
    expect(await blob?.text()).toContain("00:00:10.000 --> 00:00:20.000\nLine one");
    cleanup();
    expect(revoke).toHaveBeenCalledWith("blob:captions");
  });
});

describe("interview viewer: links", () => {
  it("copies a link to the current line's time", async () => {
    const user = userEvent.setup();
    stubApi({
      [detailPath]: { body: interviewDetail },
      [segmentsPath]: { body: { items: [line(0, "Line zero", null), line(1, "Line one", null)] } },
    });
    renderApp(`/interviews/${id}?t=15000`);
    await screen.findByText("Line one");
    const write = vi.spyOn(navigator.clipboard, "writeText");
    await user.click(screen.getByRole("button", { name: "Copy link to this time" }));
    expect(write).toHaveBeenCalledWith(`${window.location.origin}/interviews/${id}?t=10000`);
    expect(await screen.findByText("Link to 0:10 copied")).toBeTruthy();

    write.mockRejectedValueOnce(new Error("denied"));
    await user.click(screen.getByRole("button", { name: "Copy link to this time" }));
    expect(await screen.findByText(/couldn't be copied/)).toBeTruthy();
  });

  it("goes back to the results it came from, or to all interviews", async () => {
    stubApi({
      "/api/search": {
        body: {
          items: [
            {
              interview: interviewSummary,
              start_ms: 0,
              end_ms: 10_000,
              excerpt: [line(0, "Line zero", null)],
              matched_by: ["keyword"],
            },
          ],
          has_more: false,
          search_mode: "hybrid",
        },
      },
      "/api/search/filters": { body: { languages: [], interviewees: [] } },
      [detailPath]: { body: { ...interviewDetail, media: null } },
      [segmentsPath]: { body: { items: [line(0, "Line zero", null), line(1, "Line one", null)] } },
    });
    const router = renderApp("/search?q=rituals&language=ne");
    const [open] = await screen.findAllByRole("link", { name: /^Open at 0:00, Test interview A/ });
    await userEvent.click(open as HTMLElement);
    const back = await screen.findByRole("link", { name: "Back to results" });
    expect(back.getAttribute("href")).toBe("/search?q=rituals&language=ne");
    // Pointing at another line replaces the URL and keeps the way back.
    await userEvent.click(await screen.findByRole("button", { name: "Select the line at 0:10" }));
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ t: 10_000 });
    });
    expect(screen.getByRole("link", { name: "Back to results" })).toBeTruthy();
    await userEvent.click(screen.getByRole("link", { name: "Back to results" }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/search");
    });

    cleanup();
    renderApp(`/interviews/${id}`);
    const all = await screen.findByRole("link", { name: "All interviews" });
    expect(all.getAttribute("href")).toBe("/interviews");
    expect(screen.queryByRole("link", { name: "Back to results" })).toBeNull();
  });
});
