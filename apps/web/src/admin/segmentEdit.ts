import type { AdminSegment, SegmentEdit } from "../api/schemas";

/**
 * What to send: only fields that changed, with null where the text is back to the machine's
 * (the API stores no edit then). Returns null when nothing changed.
 */
export function buildEdit(
  line: AdminSegment,
  value: { original: string; english: string },
): SegmentEdit | null {
  const edit: SegmentEdit = {};
  const original = value.original.trim();
  if (original !== (line.original_edited ?? line.original_machine))
    edit.original_text = original === line.original_machine ? null : original;
  const english = value.english.trim();
  if (english !== (line.english_edited ?? line.english_machine ?? ""))
    edit.english_text = english === (line.english_machine ?? "") ? null : english;
  return Object.keys(edit).length > 0 ? edit : null;
}
