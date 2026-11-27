import Box from "@mui/material/Box";
import type { ReactNode } from "react";

import { englishText } from "../captions";
import { tokens } from "../theme";

/**
 * A line as a bilingual pair, original above English, like a Kathmandu street sign. Either
 * half can be missing: an English interview has no translation, and Nepal Bhasa often doesn't.
 * `lang` on the original lets the browser and screen readers treat it as that language.
 */
export function LinePair({
  original,
  english,
  lang,
  renderText = (text) => text,
  show = "both",
  originalNotes = [],
  englishNotes = [],
}: {
  original: string;
  english: string | null;
  lang: string | null;
  renderText?: (text: string) => ReactNode;
  show?: "both" | "original" | "english";
  /** Quiet labels after each half, such as "Corrected". */
  originalNotes?: string[];
  englishNotes?: string[];
}) {
  // The English view also takes an original that is itself English, so it is never shown twice.
  const asEnglish = englishText({ original_text: original, english_text: english, language: lang });
  const showOriginal = show !== "english" || asEnglish === null;
  const showEnglish = show === "english" ? asEnglish !== null : show === "both" && english !== null;
  // The English becomes the lead when it is the only half shown.
  const englishLeads = !showOriginal;
  // Asked for English, a line without any shows its original, saying so rather than passing
  // it off as the translation.
  const notesOnOriginal =
    show === "english" && asEnglish === null
      ? ["No English for this line", ...originalNotes]
      : originalNotes;
  return (
    <Box>
      {showOriginal ? (
        <Box
          component="p"
          lang={lang ?? undefined}
          sx={{ m: 0, fontSize: "1.125rem", lineHeight: 1.65, color: tokens.ink }}
        >
          <WithNotes notes={notesOnOriginal}>{renderText(original)}</WithNotes>
        </Box>
      ) : null}
      {showEnglish && asEnglish !== null ? (
        <Box
          component="p"
          lang="en"
          sx={{
            m: 0,
            fontSize: englishLeads ? "1.125rem" : "1rem",
            lineHeight: 1.55,
            color: englishLeads ? tokens.ink : tokens.inkMuted,
          }}
        >
          <WithNotes notes={english === null ? originalNotes : englishNotes}>
            {renderText(asEnglish)}
          </WithNotes>
        </Box>
      ) : null}
    </Box>
  );
}

// The text gets its own element only when labels follow it, so it can still be found alone.
function WithNotes({ notes, children }: { notes: string[]; children: ReactNode }) {
  if (notes.length === 0) return children;
  return (
    <>
      <span>{children}</span>
      {notes.map((note) => (
        <Box
          component="span"
          key={note}
          lang="en"
          sx={{
            display: "inline-block",
            ml: 1,
            fontSize: "0.75rem",
            lineHeight: 1.4,
            color: tokens.inkMuted,
            whiteSpace: "nowrap",
          }}
        >
          {note}
        </Box>
      ))}
    </>
  );
}
