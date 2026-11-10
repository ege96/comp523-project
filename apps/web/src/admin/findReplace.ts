import type { AdminSegment, FindReplace, InterviewDetail } from "../api/schemas";

export type Field = FindReplace["field"];
export type EditorInterview = Pick<InterviewDetail, "id" | "primary_language" | "media">;

/** English speech has no separate English translation (english_* stays empty). */
export function isEnglishSpeech(line: AdminSegment, interview: EditorInterview): boolean {
  return (line.language ?? interview.primary_language?.code) === "en";
}

/** The text an admin sees for a field, or null when the line has none (as the API decides). */
export function currentText(
  line: AdminSegment,
  field: Field,
  interview: EditorInterview,
): string | null {
  if (field === "original") return line.original_edited ?? line.original_machine;
  if (isEnglishSpeech(line, interview)) return null;
  return line.english_edited ?? line.english_machine;
}

/**
 * Plain-text matcher for `find`, the way the API matches it: trimmed, no pattern characters,
 * case-insensitive unless asked. Null when there's nothing to find.
 */
export function matcher(find: string, matchCase: boolean): RegExp | null {
  const text = find.trim();
  if (!text) return null;
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(escaped, matchCase ? "gu" : "giu");
}

/** How many lines contain a match in that field. */
export function countMatchingLines(
  lines: AdminSegment[],
  field: Field,
  re: RegExp | null,
  interview: EditorInterview,
): number {
  if (!re) return 0;
  return lines.filter((line) => {
    const text = currentText(line, field, interview);
    // search() ignores the global flag's lastIndex, so lines don't affect each other.
    return text !== null && text.search(re) !== -1;
  }).length;
}

/** Splits text into plain and matched parts, for highlighting. */
export function splitMatches(text: string, re: RegExp | null): { text: string; match: boolean }[] {
  if (!re) return [{ text, match: false }];
  const parts: { text: string; match: boolean }[] = [];
  let last = 0;
  // A copy starts at lastIndex 0 whatever was matched with `re` before.
  for (const m of text.matchAll(new RegExp(re))) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index), match: false });
    parts.push({ text: m[0], match: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), match: false });
  return parts;
}

export type ReplaceExample = { seq: number; startMs: number; before: string; after: string };

/** A few lines as they are and as they would be after replacing, to check before saving. */
export function previewReplace(
  lines: AdminSegment[],
  field: Field,
  re: RegExp | null,
  replacement: string,
  interview: EditorInterview,
  limit = 3,
): ReplaceExample[] {
  if (!re) return [];
  const examples: ReplaceExample[] = [];
  for (const line of lines) {
    const text = currentText(line, field, interview);
    if (text === null || text.search(re) === -1) continue;
    examples.push({
      seq: line.seq,
      startMs: line.start_ms,
      before: text,
      after: text.replace(new RegExp(re), replacement),
    });
    if (examples.length === limit) break;
  }
  return examples;
}
