import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { createParser } from "eventsource-parser";
import { useEffect } from "react";

import type { Viewer } from "../api/client";
import { useAuth } from "../auth/useAuth";
import { API_BASE_URL } from "../config";

/**
 * Live admin pages: the API streams "this interview changed" (Server-Sent Events) and the
 * pages re-read what changed through the normal routes. Nothing private travels on the stream.
 *
 * Read with fetch rather than the browser's EventSource, which can't send the sign-in token
 * in a header (putting it in the URL would leak it into logs). While the stream is down, the
 * pages fall back to polling (see `isLive`).
 */

const CHANGES_PATH = "/api/admin/changes";
/** Batches the refreshes for a burst of changes (a step finishing touches several rows). */
const FLUSH_MS = 200;
/** A reconnect this quick (the server ends streams every few minutes) doesn't start polling. */
const GRACE_MS = 5_000;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;

let live = false;

/** True while changes are arriving live, so polling can stop. */
export function isLive(): boolean {
  return live;
}

type Handlers = {
  onReady: () => void;
  onChange: (interviewId: string) => void;
  onResync: () => void;
};

/**
 * Reads one stream until it ends. Resolves with the HTTP status (200 when it ran and ended),
 * rejects on a network error or abort.
 */
export async function readChanges(
  token: string | null,
  signal: AbortSignal,
  handlers: Handlers,
): Promise<number> {
  const res = await fetch(`${API_BASE_URL}${CHANGES_PATH}`, {
    headers: {
      Accept: "text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    cache: "no-store",
    signal,
  });
  if (!res.ok || !res.body) return res.status;
  const parser = createParser({
    onEvent: (event) => {
      if (event.event === "ready") handlers.onReady();
      else if (event.event === "resync") handlers.onResync();
      else if (event.event === "change") {
        const id = (JSON.parse(event.data) as { interview_id?: unknown }).interview_id;
        if (typeof id === "string") handlers.onChange(id);
      }
    },
  });
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return res.status;
    parser.feed(value);
  }
}

/** Full jitter: a random wait up to the capped exponential delay, so tabs don't retry in step. */
export function retryDelay(attempt: number, random: () => number = Math.random): number {
  const cap = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** attempt);
  return Math.max(RETRY_MIN_MS / 2, cap * random());
}

function refreshInterviews(queryClient: QueryClient, viewer: Viewer, ids: Iterable<string>) {
  const key = viewer.key;
  // Admin lists and their counts, plus each changed interview: details, steps, transcript.
  const keys: unknown[][] = [
    ["interviews", key, "admin"],
    ["interviews", key, "list"],
  ];
  for (const id of ids) keys.push(["interviews", key, id]);
  return Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
}

function refreshAll(queryClient: QueryClient, viewer: Viewer) {
  return queryClient.invalidateQueries({ queryKey: ["interviews", viewer.key] });
}

/**
 * Keeps one change stream open while an admin page is shown and the tab is visible, and
 * reconnects with backoff when it drops. Mount once, inside the admin area.
 */
export function useLiveAdminUpdates(): void {
  const { viewer } = useAuth();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!viewer.ready) return;
    let stopped = false;
    // A function, not the variable: it changes during the awaits below, which narrowing ignores.
    const isStopped = () => stopped;
    let controller: AbortController | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const pending = new Set<string>();

    const goLive = (next: boolean) => {
      if (live === next) return;
      live = next;
      // Polling decides whether to run again after each fetch, so refresh to restart or stop
      // it, and to catch up on anything missed while the stream was down.
      void refreshAll(queryClient, viewer);
    };
    const flush = () => {
      flushTimer = undefined;
      const ids = [...pending];
      pending.clear();
      void refreshInterviews(queryClient, viewer, ids);
    };

    const connect = async () => {
      clearTimeout(retryTimer);
      if (isStopped() || controller || document.visibilityState === "hidden") return;
      const current = new AbortController();
      controller = current;
      // An object: set inside a callback, which narrowing can't see.
      const stream = { ready: false };
      let status = 0;
      try {
        status = await readChanges(await viewer.getToken(), current.signal, {
          onReady: () => {
            stream.ready = true;
            attempt = 0;
            clearTimeout(graceTimer);
            if (live) void refreshAll(queryClient, viewer); // a reconnect may have missed some
            goLive(true);
          },
          onChange: (id) => {
            pending.add(id);
            flushTimer ??= setTimeout(flush, FLUSH_MS);
          },
          onResync: () => void refreshAll(queryClient, viewer),
        });
      } catch {
        // Network error, or aborted because the tab was hidden or the page closed.
      }
      if (controller === current) controller = null;
      if (isStopped() || current.signal.aborted) return;
      // Not an admin, or an API without the stream yet: keep polling, try again slowly.
      if (status === 401 || status === 403 || status === 404) attempt = Math.max(attempt, 5);
      else if (!stream.ready) attempt += 1;
      clearTimeout(graceTimer);
      graceTimer = setTimeout(() => {
        goLive(false);
      }, GRACE_MS);
      retryTimer = setTimeout(() => void connect(), retryDelay(attempt));
    };

    // A hidden tab needn't hold a connection; on return, "ready" brings the page up to date.
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        controller?.abort();
        controller = null;
        clearTimeout(retryTimer);
        clearTimeout(graceTimer);
        live = false;
      } else {
        void connect();
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    void connect();
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisibility);
      controller?.abort();
      clearTimeout(retryTimer);
      clearTimeout(graceTimer);
      clearTimeout(flushTimer);
      live = false;
    };
  }, [viewer, queryClient]);
}
