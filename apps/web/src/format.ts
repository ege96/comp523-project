import type { InterviewSummary } from "./api/schemas";

/** 754000 -> "12:34", 3723000 -> "1:02:03". */
export function formatClock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${String(h)}:${String(m).padStart(2, "0")}:${s}` : `${String(m)}:${s}`;
}

const precisionFormats = {
  year: { year: "numeric" },
  month: { year: "numeric", month: "long" },
  day: { year: "numeric", month: "long", day: "numeric" },
} as const satisfies Record<string, Intl.DateTimeFormatOptions>;

/** Shows a recording date only as precisely as it is known ("1998", "May 1998"). */
export function formatRecordedOn(
  interview: Pick<InterviewSummary, "recorded_on" | "recorded_on_precision">,
): string | null {
  if (!interview.recorded_on) return null;
  // Date-only strings parse as UTC midnight, so format in UTC to keep the same day.
  return new Date(interview.recorded_on).toLocaleDateString("en-GB", {
    ...precisionFormats[interview.recorded_on_precision ?? "day"],
    timeZone: "UTC",
  });
}

/**
 * The label visitors see on a card for a transcript that isn't there yet, or null. A finished
 * transcript says it's machine-generated in the viewer instead, next to the text.
 */
export function transcriptLabel(status: InterviewSummary["status"]): string | null {
  switch (status) {
    case "processing":
      return "Transcript in progress";
    case "failed":
      return "Transcript unavailable";
    case "done":
      return null;
  }
}

/** 1536 -> "1.5 KB", 3_221_225_472 -> "3 GB" (binary units, as file managers show them). */
export function formatBytes(bytes: number): string {
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? value : Math.round(value * 10) / 10;
  return `${String(rounded)} ${units[unit] ?? ""}`;
}
