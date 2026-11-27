import Box from "@mui/material/Box";
import type { ReactNode } from "react";

import { tokens } from "../theme";

// One soft pill for every status label, so the same tone means the same thing everywhere.
// Each text colour is at least 5:1 on its background.
const PILL_TONES = {
  neutral: { bg: tokens.groundAlt, fg: tokens.inkMuted },
  amber: { bg: "#fbe9c8", fg: "#6e4300" },
  terracotta: { bg: "#f3e2df", fg: tokens.plateDeep },
  green: { bg: "#e2ede2", fg: "#2f5a33" },
} as const;

export type PillTone = keyof typeof PILL_TONES;

export function Pill({
  tone,
  children,
  numeric = false,
}: {
  tone: PillTone;
  children: ReactNode;
  /** Times and counts: digits of equal width. */
  numeric?: boolean;
}) {
  const { bg, fg } = PILL_TONES[tone];
  return (
    <Box
      component="span"
      sx={{
        display: "inline-block",
        px: 1.25,
        py: 0.25,
        borderRadius: 999,
        bgcolor: bg,
        color: fg,
        fontSize: "0.8125rem",
        fontWeight: 600,
        lineHeight: 1.6,
        whiteSpace: "nowrap",
        flexShrink: 0,
        fontVariantNumeric: numeric ? "tabular-nums" : undefined,
      }}
    >
      {children}
    </Box>
  );
}
