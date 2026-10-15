import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

import type { InterviewSummary } from "../api/schemas";
import { formatClock, formatRecordedOn } from "../format";
import { ArrowForwardIcon } from "./icons";
import { InterviewChips } from "./InterviewChips";
import { TextLink } from "./links";

/** Interviews as rows: the whole row opens the interview (the title link is stretched over it). */
export function InterviewList({ interviews }: { interviews: readonly InterviewSummary[] }) {
  return (
    <Paper>
      <List disablePadding>
        {interviews.map((interview, i) => (
          <ListItem
            key={interview.id}
            divider={i < interviews.length - 1}
            sx={{ py: 2.5, px: 3, "&:hover": { bgcolor: "action.hover" } }}
          >
            <InterviewRow interview={interview} />
          </ListItem>
        ))}
      </List>
    </Paper>
  );
}

function InterviewRow({ interview }: { interview: InterviewSummary }) {
  const details = [
    `Interviewee: ${interview.interviewee ?? "Unknown"}`,
    interview.primary_language?.name,
    interview.duration_ms === null ? null : formatClock(interview.duration_ms),
  ].filter(Boolean);
  return (
    <Stack
      direction={{ xs: "column", sm: "row" }}
      spacing={{ xs: 1.5, sm: 3 }}
      sx={{ width: 1, alignItems: { sm: "center" } }}
    >
      <Stack spacing={0.5} sx={{ flex: 1, minWidth: 0 }}>
        <TextLink
          to="/interviews/$interviewId"
          params={{ interviewId: interview.id }}
          variant="subtitle1"
          underline="hover"
          color="inherit"
          sx={{ fontWeight: 500, "&::after": { content: '""', position: "absolute", inset: 0 } }}
        >
          {interview.title}
        </TextLink>
        <Typography variant="body2" color="text.secondary">
          {details.join(" · ")}
        </Typography>
        <InterviewChips interview={interview} />
      </Stack>
      <Stack sx={{ width: { sm: 160 }, flexShrink: 0 }}>
        <Typography variant="overline" color="text.secondary" sx={{ lineHeight: 1.6 }}>
          Recorded
        </Typography>
        <Typography variant="body2">{formatRecordedOn(interview) ?? "Unknown"}</Typography>
      </Stack>
      {/* Decorative: the stretched title link already opens the interview. */}
      <Typography
        aria-hidden
        color="primary"
        variant="body2"
        sx={{ display: { xs: "none", md: "flex" }, alignItems: "center", gap: 1, fontWeight: 500 }}
      >
        Open interview <ArrowForwardIcon fontSize="small" />
      </Typography>
    </Stack>
  );
}
