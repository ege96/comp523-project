import { infiniteQueryOptions, QueryClient, queryOptions } from "@tanstack/react-query";
import type { z } from "zod";

import { API_BASE_URL } from "../config";
import {
  AdminSchema,
  InterviewDetailSchema,
  InterviewListSchema,
  SearchFiltersSchema,
  SearchResultsSchema,
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
  // Newest first. The API caps `limit` at 100. `filters` are the same as search's.
  list: (
    viewer: Viewer,
    {
      limit,
      offset = 0,
      filters = {},
    }: { limit: number; offset?: number; filters?: InterviewFilters },
  ) =>
    queryOptions({
      queryKey: ["interviews", viewer.key, "list", { limit, offset, filters }],
      queryFn: async ({ signal }) => {
        const query = filterQuery({ limit: String(limit), offset: String(offset) }, filters);
        return getJson(`/api/interviews?${query.toString()}`, InterviewListSchema, {
          token: await viewer.getToken(),
          signal,
        });
      },
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

/** The filters `GET /api/search` and `GET /api/interviews` share; undefined means "any".
 * Dates are YYYY-MM-DD. */
export type InterviewFilters = {
  language?: string;
  interviewee?: number | "unknown";
  from?: string;
  to?: string;
  undated?: true;
  media?: "audio" | "video";
};

export type SearchParams = InterviewFilters & { q: string };

/** `base` first, then the filters that are set. */
function filterQuery(base: Record<string, string>, filters: InterviewFilters): URLSearchParams {
  const query = new URLSearchParams(base);
  if (filters.language) query.set("language", filters.language);
  if (filters.interviewee !== undefined) query.set("interviewee", String(filters.interviewee));
  if (filters.from) query.set("recorded_from", filters.from);
  if (filters.to) query.set("recorded_to", filters.to);
  if (filters.undated) query.set("undated", "true");
  if (filters.media) query.set("media", filters.media);
  return query;
}

const SEARCH_PAGE_SIZE = 20;

export const searchQueries = {
  // Pages until the API says there's no more; it never reports a total.
  moments: (viewer: Viewer, params: SearchParams) =>
    infiniteQueryOptions({
      queryKey: ["search", viewer.key, params],
      initialPageParam: 0,
      queryFn: async ({ pageParam, signal }) => {
        const { q, ...filters } = params;
        const base = { q, limit: String(SEARCH_PAGE_SIZE), offset: String(pageParam) };
        const query = filterQuery(base, filters);
        return getJson(`/api/search?${query.toString()}`, SearchResultsSchema, {
          token: await viewer.getToken(),
          signal,
        });
      },
      getNextPageParam: (last, pages) =>
        last.has_more ? pages.length * SEARCH_PAGE_SIZE : undefined,
    }),
  filters: (viewer: Viewer) =>
    queryOptions({
      queryKey: ["search", viewer.key, "filters"],
      queryFn: async ({ signal }) =>
        getJson("/api/search/filters", SearchFiltersSchema, {
          token: await viewer.getToken(),
          signal,
        }),
      staleTime: 5 * 60_000,
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
