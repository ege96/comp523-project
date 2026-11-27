import { useQuery } from "@tanstack/react-query";

import { searchQueries, type InterviewFilters } from "./api/client";
import { useAuth } from "./auth/useAuth";

export const MEDIA_LABELS = { audio: "Audio", video: "Video" } as const;

/** Only the filter keys of a route's search params, so other params (q, page) stay out. */
export function pickFilters({
  language,
  interviewee,
  from,
  to,
  undated,
  media,
}: InterviewFilters): InterviewFilters {
  return { language, interviewee, from, to, undated, media };
}

export const isFiltered = (f: InterviewFilters) =>
  f.language !== undefined ||
  f.interviewee !== undefined ||
  f.from !== undefined ||
  f.to !== undefined ||
  f.media !== undefined;

/** The applied filters in words, e.g. "Nepali · Interviewee 7 · 1990–2001 · Video". */
export function useFilterSummary(filters: InterviewFilters): string[] {
  const { viewer } = useAuth();
  const { data } = useQuery({ ...searchQueries.filters(viewer), enabled: viewer.ready });
  const parts: string[] = [];
  if (filters.language !== undefined) {
    const code = filters.language;
    parts.push(data?.languages.find((l) => l.code === code)?.name ?? code);
  }
  if (filters.interviewee === "unknown") parts.push("Unknown interviewee");
  else if (filters.interviewee !== undefined) {
    const id = filters.interviewee;
    parts.push(data?.interviewees.find((p) => p.id === id)?.name ?? `Interviewee ${String(id)}`);
  }
  // Whole-year bounds read as years; any other date is shown exactly.
  const from = filters.from?.endsWith("-01-01") ? filters.from.slice(0, 4) : filters.from;
  const to = filters.to?.endsWith("-12-31") ? filters.to.slice(0, 4) : filters.to;
  if (from && to) parts.push(from === to ? from : `${from}–${to}`);
  else if (from) parts.push(`From ${from}`);
  else if (to) parts.push(`Up to ${to}`);
  if ((from ?? to) && filters.undated) parts.push("and undated");
  if (filters.media) parts.push(MEDIA_LABELS[filters.media]);
  return parts;
}
