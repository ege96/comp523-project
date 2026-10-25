import type { ChipProps } from "@mui/material/Chip";

import type { InterviewSummary, Job } from "../api/schemas";

type Status = InterviewSummary["status"];

/** Admin-facing names for processing status (D-008). Visitors see `transcriptLabel` instead. */
export const STATUS_LABELS = {
  processing: "Processing",
  needs_review: "Needs review",
  reviewed: "Reviewed",
  failed: "Failed",
} as const satisfies Record<Status, string>;

export const STATUS_COLORS = {
  processing: "default",
  needs_review: "warning",
  reviewed: "success",
  failed: "error",
} as const satisfies Record<Status, ChipProps["color"]>;

export const TRANSLATION_LABELS = {
  not_needed: "Not needed (English)",
  pending: "Pending",
  done: "Done",
  failed: "Failed",
} as const satisfies Record<InterviewSummary["translation_status"], string>;

const JOB_LABELS: Record<string, string> = {
  transcribe: "Transcription",
  translate: "English translation",
  index: "Search indexing",
  playback: "Playback copy",
  retranslate: "Updating English after edits",
};

export function jobLabel(job: Pick<Job, "kind">): string {
  return JOB_LABELS[job.kind] ?? job.kind;
}

/**
 * Proposal: the languages an admin can pick at upload. They match the API's seeded
 * `languages` table; the API has no route listing them yet, and refuses unknown codes.
 */
export const UPLOAD_LANGUAGES = [
  { code: "ne", name: "Nepali" },
  { code: "new", name: "Nepal Bhasa" },
  { code: "en", name: "English" },
] as const;
