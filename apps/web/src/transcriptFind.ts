// Find in one transcript, in the browser (the viewer already has every line).

/**
 * Plain-text, case-insensitive matcher for what the visitor typed. Null when there's nothing
 * to find. Both sides are NFC-normalised, so Devanagari typed one way matches text stored the
 * other way.
 */
export function finder(query: string): RegExp | null {
  const text = query.trim().normalize("NFC");
  if (!text) return null;
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
}

/** Splits text into plain and matching parts, in order, for highlighting. */
export function splitMatches(text: string, re: RegExp | null): { text: string; match: boolean }[] {
  const normal = text.normalize("NFC");
  if (!re) return [{ text: normal, match: false }];
  const parts: { text: string; match: boolean }[] = [];
  let last = 0;
  for (const m of normal.matchAll(re)) {
    if (m.index > last) parts.push({ text: normal.slice(last, m.index), match: false });
    parts.push({ text: m[0], match: true });
    last = m.index + m[0].length;
  }
  if (last < normal.length) parts.push({ text: normal.slice(last), match: false });
  return parts;
}

export function hasMatch(text: string, re: RegExp | null): boolean {
  if (!re) return false;
  re.lastIndex = 0; // a global RegExp remembers where its last test stopped
  return re.test(text.normalize("NFC"));
}
