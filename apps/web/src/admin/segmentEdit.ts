import type { AdminSegment, SegmentEdit } from "../api/schemas";

/** A line's two texts as the edit form holds them. */
export type LineText = { original: string; english: string };

/**
 * Unsaved text for one line: what the admin typed (`value`) and the stored text each box
 * started from (`base`). A box whose value still equals its base was left alone.
 */
export type LineDraft = { value: LineText; base: LineText };

/** The text the API stores for a line now: the edit, or else the machine text. */
export function storedText(line: AdminSegment): LineText {
  return {
    original: line.original_edited ?? line.original_machine,
    english: line.english_edited ?? line.english_machine ?? "",
  };
}

const FIELDS = ["original", "english"] as const;

/**
 * A draft moved onto the line's current text: boxes the admin changed keep their text and
 * base; boxes left alone take the current stored text, so a correction saved meanwhile (by a
 * replacement, say) shows and is never sent back as it was.
 */
export function rebase(draft: LineDraft | undefined, stored: LineText): LineDraft {
  const value = { ...stored };
  const base = { ...stored };
  if (draft)
    for (const name of FIELDS)
      if (draft.value[name] !== draft.base[name]) {
        value[name] = draft.value[name];
        base[name] = draft.base[name];
      }
  return { value, base };
}

/**
 * What to send: only the boxes the admin changed from their base, and only where that differs
 * from what is stored now, with null where the text is back to the machine's (the API then
 * stores no edit). A box left alone is left out, and the API keeps its current text. With
 * `confirmEnglish` the stored English is sent even unchanged: that marks a flagged English
 * edit as checked against the current original. Returns null when there is nothing to send.
 */
export function buildEdit(
  line: AdminSegment,
  { value, base }: LineDraft,
  { confirmEnglish = false }: { confirmEnglish?: boolean } = {},
): SegmentEdit | null {
  const edit: SegmentEdit = {};
  const stored = storedText(line);
  const original = value.original.trim();
  if (value.original !== base.original && original !== stored.original)
    edit.original_text = original === line.original_machine ? null : original;
  const englishChanged = value.english !== base.english;
  const english = (englishChanged ? value.english : stored.english).trim();
  if ((englishChanged && english !== stored.english) || confirmEnglish)
    edit.english_text = english === (line.english_machine ?? "") ? null : english;
  return Object.keys(edit).length > 0 ? edit : null;
}
