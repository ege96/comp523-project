import Box from "@mui/material/Box";
import type { ReactNode } from "react";

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
}: {
  original: string;
  english: string | null;
  lang: string | null;
  renderText?: (text: string) => ReactNode;
  show?: "both" | "original" | "english";
}) {
  const showOriginal = show !== "english" || english === null;
  const showEnglish = show !== "original" && english !== null;
  // The English becomes the lead when it is the only half shown.
  const englishLeads = !showOriginal;
  return (
    <Box>
      {showOriginal ? (
        <Box
          component="p"
          lang={lang ?? undefined}
          sx={{ m: 0, fontSize: "1.125rem", lineHeight: 1.65, color: tokens.ink }}
        >
          {renderText(original)}
        </Box>
      ) : null}
      {showEnglish ? (
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
          {renderText(english)}
        </Box>
      ) : null}
    </Box>
  );
}
