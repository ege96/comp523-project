import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";

import { ApiError, getJson, type Viewer } from "../api/client";
import {
  AdminSegmentListSchema,
  AdminSegmentSchema,
  InterviewListSchema,
  JobListSchema,
  ReplaceResultSchema,
  RerunConflictSchema,
  RetranslateResultSchema,
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

export type Status = InterviewSummary["status"];
type Visibility = InterviewSummary["visibility"];

/** How often admin screens re-ask while the worker is still busy (there is no push yet). */
export const PROCESSING_POLL_MS = 10_000;

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
        q.state.data?.items.some((i) => i.status === "processing") ? PROCESSING_POLL_MS : false,
    }),
  jobs: (viewer: Viewer, id: string) =>
    queryOptions({
      queryKey: ["interviews", viewer.key, id, "jobs"],
      queryFn: async ({ signal }) =>
        getJson(`/api/interviews/${encodeURIComponent(id)}/jobs`, JobListSchema, {
          token: await viewer.getToken(),
          signal,
        }),
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
        q.state.data?.items.some((line) => line.english_stale) ? PROCESSING_POLL_MS : false,
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

/** Publish (Public) or hide (Private) an interview. Allowed at any time (D-008). */
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
 * Correct an interview's details after upload (D-004). Only the fields given change; null
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
    },
    // The public transcript, the job list and search results change too.
    onSettled: () =>
      Promise.all(
        ["interviews", "search"].map((prefix) =>
          queryClient.invalidateQueries({ queryKey: [prefix, viewer.key] }),
        ),
      ),
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
    },
    onSettled: () =>
      Promise.all(
        ["interviews", "search"].map((prefix) =>
          queryClient.invalidateQueries({ queryKey: [prefix, viewer.key] }),
        ),
      ),
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

/** Transcribing again was refused because this many lines have corrections (P-013). */
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
