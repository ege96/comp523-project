import { queryOptions, useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { ApiError, getJson, interviewQueries, type Viewer } from "../api/client";
import {
  AdminSegmentListSchema,
  AdminSegmentSchema,
  InterviewCountsSchema,
  InterviewListSchema,
  JobListSchema,
  ReplaceResultSchema,
  RerunConflictSchema,
  RetranslateResultSchema,
  StorageSpaceSchema,
  type AdminSegment,
  type FindReplace,
  type InterviewSummary,
  type InterviewUpdate,
  type ReplaceResult,
  type RerunStep,
  type SegmentEdit,
} from "../api/schemas";
import { API_BASE_URL } from "../config";
import { useAuth } from "../auth/useAuth";
import { isLive } from "./live";

export type Status = InterviewSummary["status"];
type Visibility = InterviewSummary["visibility"];

/** How often admin screens re-ask while the worker is busy, when live updates are down. */
export const PROCESSING_POLL_MS = 10_000;

/**
 * Admin screens don't refetch when the tab gets focus: the live stream reconnects then and
 * refreshes everything once it is up (or polling takes over), so a focus refetch would only
 * fetch the same data twice.
 */
export const NO_FOCUS_REFETCH = { refetchOnWindowFocus: false } as const;

// Admin queries share the "interviews" prefix, so one invalidation refreshes public pages too.
export const adminQueries = {
  // Every interview, Private included (the API decides that from the token), newest first.
  interviews: (
    viewer: Viewer,
    {
      status,
      visibility,
      limit,
      offset = 0,
    }: { status?: Status; visibility?: Visibility; limit: number; offset?: number },
  ) =>
    queryOptions({
      queryKey: ["interviews", viewer.key, "admin", { status, visibility, limit, offset }],
      queryFn: async ({ signal }) => {
        const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
        if (status) query.set("status", status);
        if (visibility) query.set("visibility", visibility);
        return getJson(`/api/interviews?${query.toString()}`, InterviewListSchema, {
          token: await viewer.getToken(),
          signal,
        });
      },
      refetchInterval: (q) =>
        !isLive() && q.state.data?.items.some((i) => i.status === "processing")
          ? PROCESSING_POLL_MS
          : false,
      ...NO_FOCUS_REFETCH,
    }),
  // How many interviews of each status and visibility, for the tab counts, in one request.
  counts: (viewer: Viewer) =>
    queryOptions({
      queryKey: ["interviews", viewer.key, "admin", "counts"],
      queryFn: async ({ signal }) =>
        getJson("/api/admin/interview-counts", InterviewCountsSchema, {
          token: await viewer.getToken(),
          signal,
        }),
      ...NO_FOCUS_REFETCH,
    }),
  jobs: (viewer: Viewer, id: string) =>
    queryOptions({
      queryKey: ["interviews", viewer.key, id, "jobs"],
      queryFn: async ({ signal }) =>
        getJson(`/api/interviews/${encodeURIComponent(id)}/jobs`, JobListSchema, {
          token: await viewer.getToken(),
          signal,
        }),
      ...NO_FOCUS_REFETCH,
    }),
  // Every line with its machine text and any edit, for the transcript editor.
  transcript: (viewer: Viewer, id: string) =>
    queryOptions({
      queryKey: ["interviews", viewer.key, id, "transcript"],
      queryFn: async ({ signal }) =>
        getJson(`/api/interviews/${encodeURIComponent(id)}/transcript`, AdminSegmentListSchema, {
          token: await viewer.getToken(),
          signal,
        }),
      // Out-of-date English is refreshed by the worker a few minutes after the last edit.
      refetchInterval: (q) =>
        !isLive() && q.state.data?.items.some((line) => line.english_stale)
          ? PROCESSING_POLL_MS
          : false,
      ...NO_FOCUS_REFETCH,
    }),
  // Room left for uploads, so a batch that won't fit is flagged before it starts.
  storage: (viewer: Viewer) =>
    queryOptions({
      queryKey: ["storage", viewer.key],
      queryFn: async ({ signal }) =>
        getJson("/api/storage", StorageSpaceSchema, { token: await viewer.getToken(), signal }),
      ...NO_FOCUS_REFETCH,
    }),
};

async function patchInterview(token: string | null, id: string, update: InterviewUpdate) {
  const url = `${API_BASE_URL}/api/interviews/${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(update),
  });
  if (!res.ok) throw new ApiError(res.status, url);
}

/** Publish (Public) or hide (Private) an interview. Allowed at any time. */
export function useSetVisibility() {
  const { viewer } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, visibility }: { id: string; visibility: Visibility }) =>
      patchInterview(await viewer.getToken(), id, { visibility }),
    // Search results and filters change too, so refresh everything this viewer has cached.
    onSettled: () =>
      Promise.all(
        ["interviews", "search"].map((prefix) =>
          queryClient.invalidateQueries({ queryKey: [prefix, viewer.key] }),
        ),
      ),
  });
}

/**
 * Correct an interview's details after upload. Only the fields given change; null
 * clears an optional one, and `language: null` goes back to the detected language.
 */
export function useUpdateInterview(interviewId: string) {
  const { viewer } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (update: InterviewUpdate) =>
      patchInterview(await viewer.getToken(), interviewId, update),
    // The title, interviewee and language show in lists, filters and search results too.
    onSettled: () =>
      Promise.all(
        ["interviews", "search"].map((prefix) =>
          queryClient.invalidateQueries({ queryKey: [prefix, viewer.key] }),
        ),
      ),
  });
}

/**
 * What saved transcript text changes besides the admin transcript (which the caller updates
 * from the response): the public transcript, the jobs (search indexing and maybe an English
 * update are queued) and search results. The interview itself is unchanged.
 */
function refreshAfterTextEdit(queryClient: QueryClient, viewer: Viewer, interviewId: string) {
  const search = queryClient.invalidateQueries({ queryKey: ["search", viewer.key] });
  // While live, the queued search update arrives as a change and refreshes the rest.
  if (isLive()) return search;
  return Promise.all([
    queryClient.invalidateQueries({
      queryKey: interviewQueries.segments(viewer, interviewId).queryKey,
    }),
    queryClient.invalidateQueries({ queryKey: adminQueries.jobs(viewer, interviewId).queryKey }),
    search,
  ]);
}

async function patchSegment(
  token: string | null,
  id: string,
  seq: number,
  edit: SegmentEdit,
): Promise<AdminSegment> {
  const url = `${API_BASE_URL}/api/interviews/${encodeURIComponent(id)}/segments/${String(seq)}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(edit),
  });
  if (!res.ok) throw new ApiError(res.status, url);
  const parsed = AdminSegmentSchema.safeParse(await res.json().catch(() => undefined));
  if (!parsed.success) throw new ApiError(res.status, url);
  return parsed.data;
}

/**
 * Save a correction to one transcript line. A string replaces the text; null goes back to the
 * machine text. The API queues re-indexing, so search finds the new words shortly after.
 */
export function useEditSegment(interviewId: string) {
  const { viewer } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ seq, edit }: { seq: number; edit: SegmentEdit }) =>
      patchSegment(await viewer.getToken(), interviewId, seq, edit),
    onSuccess: (saved) => {
      queryClient.setQueryData(
        adminQueries.transcript(viewer, interviewId).queryKey,
        (old) => old && { items: old.items.map((line) => (line.seq === saved.seq ? saved : line)) },
      );
      return refreshAfterTextEdit(queryClient, viewer, interviewId);
    },
    // The line may have changed on the server anyway (a refused save after someone else's).
    onError: () =>
      queryClient.invalidateQueries({
        queryKey: adminQueries.transcript(viewer, interviewId).queryKey,
      }),
  });
}

async function postReplace(
  token: string | null,
  id: string,
  body: FindReplace,
): Promise<ReplaceResult> {
  const url = `${API_BASE_URL}/api/interviews/${encodeURIComponent(id)}/transcript/replace`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new ApiError(res.status, url);
  const parsed = ReplaceResultSchema.safeParse(await res.json().catch(() => undefined));
  if (!parsed.success) throw new ApiError(res.status, url);
  return parsed.data;
}

/**
 * Replace a word or phrase in every line of one interview (say, a name the speech recognition
 * always gets wrong). Each changed line becomes an edit, so "Use machine text" still undoes it.
 */
export function useReplaceText(interviewId: string) {
  const { viewer } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: FindReplace) =>
      postReplace(await viewer.getToken(), interviewId, body),
    onSuccess: ({ items }) => {
      const changed = new Map(items.map((line) => [line.seq, line]));
      queryClient.setQueryData(
        adminQueries.transcript(viewer, interviewId).queryKey,
        (old) => old && { items: old.items.map((line) => changed.get(line.seq) ?? line) },
      );
      return items.length > 0 ? refreshAfterTextEdit(queryClient, viewer, interviewId) : undefined;
    },
    onError: () =>
      queryClient.invalidateQueries({
        queryKey: adminQueries.transcript(viewer, interviewId).queryKey,
      }),
  });
}

/** Re-translate the lines whose English is out of date now, instead of after the delay. */
export function useRetranslate(interviewId: string) {
  const { viewer } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const token = await viewer.getToken();
      const url = `${API_BASE_URL}/api/interviews/${encodeURIComponent(interviewId)}/retranslate`;
      const res = await fetch(url, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new ApiError(res.status, url);
      const parsed = RetranslateResultSchema.safeParse(await res.json().catch(() => undefined));
      if (!parsed.success) throw new ApiError(res.status, url);
      return parsed.data;
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["interviews", viewer.key, interviewId] }),
  });
}

/** Transcribing again was refused because this many lines have corrections. */
export class CorrectionsWouldBeLost extends Error {
  constructor(readonly correctedLines: number) {
    super(`${String(correctedLines)} corrected lines would be replaced`);
    this.name = "CorrectionsWouldBeLost";
  }
}

/**
 * Run a processing step again: retry one that failed, or redo the transcript or English after
 * the language was corrected. Transcribing again over corrections fails with
 * `CorrectionsWouldBeLost` unless `replaceCorrections` is set.
 */
export function useRerun(interviewId: string) {
  const { viewer } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      step,
      replaceCorrections = false,
    }: {
      step: RerunStep;
      replaceCorrections?: boolean;
    }) => {
      const token = await viewer.getToken();
      const url = `${API_BASE_URL}/api/interviews/${encodeURIComponent(interviewId)}/rerun`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ step, replace_corrections: replaceCorrections }),
      });
      if (res.status === 409) {
        const conflict = RerunConflictSchema.safeParse(await res.json().catch(() => undefined));
        if (conflict.success)
          throw new CorrectionsWouldBeLost(conflict.data.detail.corrected_lines);
      }
      if (!res.ok) throw new ApiError(res.status, url);
    },
    onSettled: () =>
      Promise.all(
        ["interviews", "search"].map((prefix) =>
          queryClient.invalidateQueries({ queryKey: [prefix, viewer.key] }),
        ),
      ),
  });
}

/** Deleting was refused because the interview is published (visitors could be on it). */
export class StillPublished extends Error {
  constructor() {
    super("Unpublish the interview before deleting it");
    this.name = "StillPublished";
  }
}

/**
 * Delete an interview for good: its recording, transcript, corrections and search entries.
 * The API refuses a published one (`StillPublished`). Afterwards everything cached about it
 * is dropped rather than refetched, so going back never flashes the deleted page.
 */
export function useDeleteInterview(interviewId: string) {
  const { viewer } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const token = await viewer.getToken();
      const url = `${API_BASE_URL}/api/interviews/${encodeURIComponent(interviewId)}`;
      const res = await fetch(url, {
        method: "DELETE",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.status === 409) throw new StillPublished();
      // Already gone (another admin, another tab): the outcome the admin wanted.
      if (!res.ok && res.status !== 404) throw new ApiError(res.status, url);
    },
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: ["interviews", viewer.key, interviewId] });
      await Promise.all(
        ["interviews", "search", "storage"].map((prefix) =>
          queryClient.invalidateQueries({ queryKey: [prefix, viewer.key] }),
        ),
      );
    },
  });
}
