/** One caption: a transcript line's time span and text. */
export type Cue = { start_ms: number; end_ms: number; text: string };

/** WebVTT timestamp: HH:MM:SS.mmm. */
export function formatVttTime(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor(total / 60_000) % 60;
  const seconds = Math.floor(total / 1000) % 60;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(total % 1000, 3)}`;
}

// Cue text may not hold "-->", a bare "&" or "<" (WebVTT §4.2.2), nor a blank line, which
// would end the cue early.
function escapeCueText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r?\n\s*\r?\n/g, "\n")
    .trim();
}

/** A WebVTT file from transcript lines; lines with no text or no length are left out. */
export function toVtt(cues: Cue[]): string {
  const blocks = cues
    .map((c) => ({ ...c, text: escapeCueText(c.text) }))
    .filter((c) => c.text !== "" && c.end_ms > c.start_ms)
    .map((c) => `${formatVttTime(c.start_ms)} --> ${formatVttTime(c.end_ms)}\n${c.text}`);
  return ["WEBVTT", ...blocks].join("\n\n") + "\n";
}
