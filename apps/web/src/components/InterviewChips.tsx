import Chip from "@mui/material/Chip";
import Stack from "@mui/material/Stack";

import type { InterviewSummary } from "../api/schemas";
import { transcriptLabel } from "../format";

/** Private (admins only ever see it) and how far along the transcript is (D-008). */
export function InterviewChips({
  interview,
}: {
  interview: Pick<InterviewSummary, "visibility" | "status">;
}) {
  const label = transcriptLabel(interview.status);
  return (
    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
      {interview.visibility === "private" ? (
        <Chip size="small" color="warning" label="Private" />
      ) : null}
      {label ? <Chip size="small" variant="outlined" label={label} /> : null}
    </Stack>
  );
}
