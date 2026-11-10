import Box from "@mui/material/Box";

import { tokens } from "../theme";
import { QUEUE_LABELS, type Queue } from "./workflow";

// Soft pills, as in the admin mockup. Each text colour is at least 5:1 on its background.
const PILL_COLORS = {
  attention: { bg: "#fbe9c8", fg: "#6e4300" },
  processing: { bg: tokens.groundAlt, fg: tokens.inkMuted },
  ready: { bg: "#f3e2df", fg: tokens.plateDeep },
  published: { bg: "#e2ede2", fg: "#2f5a33" },
} as const satisfies Record<Queue, { bg: string; fg: string }>;

/** Where a recording is in the admin's work, in the same words as the home page's tabs. */
export function StagePill({ queue }: { queue: Queue }) {
  const { bg, fg } = PILL_COLORS[queue];
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
      }}
    >
      {QUEUE_LABELS[queue]}
    </Box>
  );
}
