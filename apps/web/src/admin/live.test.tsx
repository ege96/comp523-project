import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AdminSegment, InterviewDetail, Job } from "../api/schemas";
import { interviewDetail } from "../test/fixtures";
import { fakeAuthClient, renderApp, stubApi } from "../test/renderApp";
import { readChanges, retryDelay } from "./live";

const SLOW = { timeout: 5000 };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** A streamed SSE body the test writes to, the way the API sends it. */
function sseStream() {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    body,
    send: (text: string) => {
      controller.enqueue(encoder.encode(text));
    },
    end: () => {
      controller.close();
    },
  };
}

describe("reading the change stream", () => {
  it("parses events split across chunks, ignores keep-alives, and sends the token", async () => {
    const stream = sseStream();
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(stream.body, { headers: { "Content-Type": "text/event-stream" } }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const seen: string[] = [];
    const done = readChanges("tok", new AbortController().signal, {
      onReady: () => seen.push("ready"),
      onChange: (id) => seen.push(`change ${id}`),
      onResync: () => seen.push("resync"),
    });
    stream.send("event: ready\ndata: {}\n\n: ping\n\nevent: cha");
    stream.send('nge\ndata: {"interview_id": "abc"}\n\nevent: resync\ndata: {}\n\n');
    stream.end();
    expect(await done).toBe(200);
    expect(seen).toEqual(["ready", "change abc", "resync"]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/admin\/changes$/);
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer tok");
  });

  it("returns the status when the API refuses", async () => {
    stubApi({});
    const handlers = { onReady: vi.fn(), onChange: vi.fn(), onResync: vi.fn() };
    expect(await readChanges(null, new AbortController().signal, handlers)).toBe(404);
    expect(handlers.onReady).not.toHaveBeenCalled();
  });

  it("waits a random, capped, growing time between retries", () => {
    expect(retryDelay(0, () => 1)).toBe(1_000);
    expect(retryDelay(3, () => 1)).toBe(8_000);
    expect(retryDelay(20, () => 1)).toBe(30_000);
    expect(retryDelay(20, () => 0)).toBe(500);
  });
});

describe("the admin page with live updates", () => {
  const processing: InterviewDetail = {
    ...interviewDetail,
    status: "processing",
    status_detail: "Transcribing",
    translation_status: "pending",
  };
  const job = (kind: string, state: Job["state"]): Job => ({
    kind,
    state,
    attempts: 1,
    max_attempts: 3,
    last_error: null,
    created_at: "2026-10-14T00:00:00Z",
    finished_at: null,
  });
  const line: AdminSegment = {
    seq: 0,
    start_ms: 0,
    end_ms: 5_000,
    language: "ne",
    original_machine: "Freshly transcribed line",
    original_edited: null,
    english_machine: null,
    english_edited: null,
    edited_at: null,
    english_stale: false,
    english_edit_stale: false,
    edited_by: null,
  };
  const base = `/api/interviews/${processing.id}`;

  it("shows the transcript and the new status as soon as a step finishes", async () => {
    const routes: Parameters<typeof stubApi>[0] = {
      "/api/auth/me": { body: { id: 1, email: "someone@example.org" } },
      [base]: { body: processing },
      [`${base}/jobs`]: { body: { items: [job("transcribe", "running")] } },
      [`${base}/transcript`]: { body: { items: [] } },
    };
    stubApi(routes);
    const stubbed = vi.mocked(fetch);
    const stream = sseStream();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string, init?: RequestInit) =>
        input.endsWith("/api/admin/changes")
          ? Promise.resolve(new Response(stream.body))
          : stubbed(input, init),
      ),
    );
    renderApp(`/admin/interviews/${processing.id}`, fakeAuthClient({ signedIn: true }));

    expect(await screen.findByText(/no transcript yet/, {}, SLOW)).toBeTruthy();
    stream.send("event: ready\ndata: {}\n\n");

    // The worker finishes transcribing; the stream says so and the page re-reads.
    routes[base] = { body: { ...processing, status_detail: "Translating" } };
    routes[`${base}/jobs`] = {
      body: { items: [job("transcribe", "done"), job("translate", "running")] },
    };
    routes[`${base}/transcript`] = { body: { items: [line] } };
    stream.send(`event: change\ndata: {"interview_id": "${processing.id}"}\n\n`);

    expect(await screen.findByText("Freshly transcribed line", {}, SLOW)).toBeTruthy();
    expect(screen.getByText("Translating")).toBeTruthy();
    stream.end();
  });
});
