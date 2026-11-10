import Stack from "@mui/material/Stack";

import type { InterviewSummary } from "../api/schemas";
import { transcriptLabel } from "../format";
import { Pill } from "./Pill";

/** Private (admins only ever see it), and whether the transcript is still being made. */
export function InterviewChips({
  interview,
}: {
  interview: Pick<InterviewSummary, "visibility" | "status">;
}) {
  const label = transcriptLabel(interview.status);
  if (interview.visibility !== "private" && !label) return null;
  return (
    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
      {interview.visibility === "private" ? <Pill tone="amber">Private</Pill> : null}
      {label ? <Pill tone="neutral">{label}</Pill> : null}
    </Stack>
  );
}
