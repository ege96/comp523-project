import { QueryClient, queryOptions } from "@tanstack/react-query";
import type { z } from "zod";

import { API_BASE_URL } from "../config";
import {
  AdminSchema,
  InterviewDetailSchema,
  InterviewListSchema,
  SegmentListSchema,
} from "./schemas";

/** The API answered with an error status, or with a body this client doesn't understand. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    url: string,
  ) {
    super(`Unexpected response from ${url} (HTTP ${String(status)})`);
    this.name = "ApiError";
  }
}

export async function getJson<T>(
  path: string,
  schema: z.ZodType<T>,
  { token, signal }: { token?: string | null; signal?: AbortSignal } = {},
): Promise<T> {
  const url = `${API_BASE_URL}${path}`;
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal,
  });
  if (!res.ok) throw new ApiError(res.status, url);
  const parsed = schema.safeParse(await res.json().catch(() => undefined));
  if (!parsed.success) throw new ApiError(res.status, url);
  return parsed.data;
}

/**
 * Who is asking. `key` goes into every query key, so an admin's cached Private data is never
 * shown to the next visitor on the same tab. The API still decides what each viewer gets.
 */
export type Viewer = { key: string; getToken: () => Promise<string | null> };

export const interviewQueries = {
  // Proposal: the home page shows the 20 most recently added interviews.
  recent: (viewer: Viewer) =>
    queryOptions({
      queryKey: ["interviews", viewer.key, "recent"],
      queryFn: async ({ signal }) =>
        getJson("/api/interviews?limit=20", InterviewListSchema, {
          token: await viewer.getToken(),
          signal,
        }),
    }),
  detail: (viewer: Viewer, id: string) =>
    queryOptions({
      queryKey: ["interviews", viewer.key, id],
      queryFn: async ({ signal }) =>
        getJson(`/api/interviews/${encodeURIComponent(id)}`, InterviewDetailSchema, {
          token: await viewer.getToken(),
          signal,
        }),
    }),
  segments: (viewer: Viewer, id: string) =>
    queryOptions({
      queryKey: ["interviews", viewer.key, id, "segments"],
      queryFn: async ({ signal }) =>
        getJson(`/api/interviews/${encodeURIComponent(id)}/segments`, SegmentListSchema, {
          token: await viewer.getToken(),
          signal,
        }),
    }),
};

export type AdminCheck = "admin" | "notAdmin";

/** The API decides who is an admin; Firebase only says who someone is. */
export async function checkAdmin(token: string): Promise<AdminCheck> {
  try {
    await getJson("/api/auth/me", AdminSchema, { token });
    return "admin";
  } catch (error) {
    // 401 (token the API won't accept) or 403 (not in the admins table): not an admin here.
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      return "notAdmin";
    }
    throw error;
  }
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        // A 4xx won't change on retry (a Private interview is a 404 for visitors).
        retry: (count, error) =>
          !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
      },
    },
  });
}
