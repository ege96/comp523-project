import { z } from "zod";

import type { components } from "./schema.gen";

// Runtime checks for API responses (D-009). Each schema `satisfies` the type generated from the
// API's OpenAPI document, so `npm run gen:api` after an API change makes tsc flag any drift.
type Schemas = components["schemas"];

const Language = z.object({ code: z.string(), name: z.string() });

const InterviewSummary = z.object({
  id: z.string(),
  title: z.string(),
  interviewee: z.string().nullable(),
  primary_language: Language.nullable(),
  duration_ms: z.number().int().nullable(),
  recorded_on: z.iso.date().nullable(),
  recorded_on_precision: z.enum(["year", "month", "day"]).nullable(),
  visibility: z.enum(["public", "private"]),
  status: z.enum(["processing", "needs_review", "reviewed", "failed"]),
  translation_status: z.enum(["not_needed", "pending", "done", "failed"]),
  created_at: z.string(),
}) satisfies z.ZodType<Schemas["InterviewSummary"]>;

export const InterviewListSchema = z.object({
  items: z.array(InterviewSummary),
  total: z.number().int(),
}) satisfies z.ZodType<Schemas["InterviewList"]>;

export const InterviewDetailSchema = InterviewSummary.extend({
  interviewer: z.string().nullable(),
  location: z.string().nullable(),
  description: z.string().nullable(),
  consent_note: z.string().nullable(),
  languages: z.array(Language),
  media: z.object({ url: z.string(), content_type: z.string(), expires_at: z.string() }).nullable(),
  status_detail: z.string().nullable(),
}) satisfies z.ZodType<Schemas["InterviewDetail"]>;

const Segment = z.object({
  seq: z.number().int(),
  start_ms: z.number().int(),
  end_ms: z.number().int(),
  language: z.string().nullable(),
  original_text: z.string(),
  english_text: z.string().nullable(),
  original_edited: z.boolean(),
  english_edited: z.boolean(),
}) satisfies z.ZodType<Schemas["Segment"]>;

export const SegmentListSchema = z.object({
  items: z.array(Segment),
}) satisfies z.ZodType<Schemas["SegmentList"]>;

export const SearchResultsSchema = z.object({
  items: z.array(
    z.object({
      interview: InterviewSummary,
      start_ms: z.number().int(),
      end_ms: z.number().int(),
      excerpt: z.array(Segment),
      matched_by: z.array(z.enum(["keyword", "semantic"])),
    }),
  ),
  has_more: z.boolean(),
  search_mode: z.enum(["hybrid", "keyword_only"]),
}) satisfies z.ZodType<Schemas["SearchResults"]>;

export const SearchFiltersSchema = z.object({
  languages: z.array(Language),
  interviewees: z.array(z.object({ id: z.number().int(), name: z.string() })),
}) satisfies z.ZodType<Schemas["SearchFilters"]>;

export const AdminSchema = z.object({
  id: z.number().int(),
  email: z.string(),
}) satisfies z.ZodType<Schemas["AdminResponse"]>;

export const JobListSchema = z.object({
  items: z.array(
    z.object({
      kind: z.string(),
      state: z.enum(["queued", "running", "done", "failed"]),
      attempts: z.number().int(),
      max_attempts: z.number().int(),
      last_error: z.string().nullable(),
      created_at: z.string(),
      finished_at: z.string().nullable(),
    }),
  ),
}) satisfies z.ZodType<Schemas["JobList"]>;

// Admin-only: machine text and edits side by side, for the transcript editor.
export const AdminSegmentListSchema = z.object({
  items: z.array(
    z.object({
      seq: z.number().int(),
      start_ms: z.number().int(),
      end_ms: z.number().int(),
      language: z.string().nullable(),
      original_machine: z.string(),
      original_edited: z.string().nullable(),
      english_machine: z.string().nullable(),
      english_edited: z.string().nullable(),
      edited_at: z.string().nullable(),
      edited_by: z.string().nullable(),
    }),
  ),
}) satisfies z.ZodType<Schemas["AdminSegmentList"]>;

export const AdminSegmentSchema = AdminSegmentListSchema.shape.items.element;

export const ReplaceResultSchema = z.object({
  items: z.array(AdminSegmentSchema),
  skipped: z.number().int(),
}) satisfies z.ZodType<Schemas["ReplaceResult"]>;

export type InterviewUpdate = Schemas["InterviewUpdate"];
export type SegmentEdit = Schemas["SegmentEdit"];
export type FindReplace = Schemas["FindReplace"];
export type ReplaceResult = z.infer<typeof ReplaceResultSchema>;
export type AdminSegment = z.infer<typeof AdminSegmentSchema>;

export type InterviewSummary = z.infer<typeof InterviewSummary>;
export type InterviewDetail = z.infer<typeof InterviewDetailSchema>;
export type Segment = z.infer<typeof Segment>;
export type Job = z.infer<typeof JobListSchema>["items"][number];
export type Moment = z.infer<typeof SearchResultsSchema>["items"][number];
