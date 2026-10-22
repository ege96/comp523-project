import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";

import { ApiError, getJson, type Viewer } from "../api/client";
import {
  InterviewListSchema,
  JobListSchema,
  type InterviewSummary,
  type InterviewUpdate,
} from "../api/schemas";
import { API_BASE_URL } from "../config";
import { useAuth } from "../auth/useAuth";

export type Status = InterviewSummary["status"];

/** How often admin screens re-ask while the worker is still busy (there is no push yet). */
export const PROCESSING_POLL_MS = 10_000;

// Admin queries share the "interviews" prefix, so one invalidation refreshes public pages too.
export const adminQueries = {
  // Every interview, Private included (the API decides that from the token), newest first.
  interviews: (
    viewer: Viewer,
    { status, limit, offset = 0 }: { status?: Status; limit: number; offset?: number },
  ) =>
    queryOptions({
      queryKey: ["interviews", viewer.key, "admin", { status, limit, offset }],
      queryFn: async ({ signal }) => {
        const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
        if (status) query.set("status", status);
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
    mutationFn: async ({ id, visibility }: { id: string } & InterviewUpdate) =>
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
