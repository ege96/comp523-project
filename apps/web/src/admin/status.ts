import type { InterviewSummary } from "../api/schemas";

export const TRANSLATION_LABELS = {
  not_needed: "Not needed (English)",
  pending: "Pending",
  done: "Done",
  failed: "Failed",
} as const satisfies Record<InterviewSummary["translation_status"], string>;

/**
 * The languages an admin can pick at upload. They match the API's seeded
 * `languages` table; the API has no route listing them yet, and refuses unknown codes.
 */
export const UPLOAD_LANGUAGES = [
  { code: "ne", name: "Nepali" },
  { code: "new", name: "Nepal Bhasa" },
  { code: "en", name: "English" },
] as const;

/** A language's name for a code the API sent, or the code itself if it's not one we list. */
export function languageName(code: string): string {
  return UPLOAD_LANGUAGES.find((l) => l.code === code)?.name ?? code;
}
