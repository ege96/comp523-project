import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";

import type { InterviewSummary } from "../api/schemas";
import { formatClock, formatRecordedOn } from "../format";
import { tokens } from "../theme";
import { InterviewChips } from "./InterviewChips";
import { TextLink } from "./links";
import { visuallyHidden } from "./visuallyHidden";

// Title | Interviewee | Language | Length | Recorded, as a ruled catalogue on wide screens.
const columns = {
  md: "minmax(0, 2.4fr) minmax(0, 1.3fr) minmax(0, 0.9fr) 5.5rem minmax(0, 1fr)",
} as const;

/** Interviews as catalogue rows: the whole row opens the interview (the title link is stretched). */
export function InterviewList({ interviews }: { interviews: readonly InterviewSummary[] }) {
  return (
    <Box sx={{ borderTop: `2px solid ${tokens.ink}` }}>
      <Box
        aria-hidden
        sx={{
          display: { xs: "none", md: "grid" },
          gridTemplateColumns: columns,
          columnGap: 3,
          py: 1,
          borderBottom: 1,
          borderColor: "divider",
          color: "text.secondary",
          typography: "caption",
          fontWeight: 600,
        }}
      >
        <span>Title</span>
        <span>Interviewee</span>
        <span>Language</span>
        <Box component="span" sx={{ textAlign: "right" }}>
          Length
        </Box>
        <span>Recorded</span>
      </Box>
      <Box component="ul" sx={{ listStyle: "none", m: 0, p: 0 }}>
        {interviews.map((interview) => (
          <InterviewRow key={interview.id} interview={interview} />
        ))}
      </Box>
    </Box>
  );
}

function InterviewRow({ interview }: { interview: InterviewSummary }) {
  const length = interview.duration_ms === null ? null : formatClock(interview.duration_ms);
  const recorded = formatRecordedOn(interview);
  const cell = { typography: "body2", color: "text.secondary", fontVariantNumeric: "tabular-nums" };
  return (
    <Box
      component="li"
      sx={{
        position: "relative",
        display: "grid",
        gridTemplateColumns: { xs: "1fr", md: columns.md },
        columnGap: 3,
        rowGap: 0.5,
        alignItems: "baseline",
        py: { xs: 2, md: 1.75 },
        borderBottom: 1,
        borderColor: "divider",
        "&:hover": { bgcolor: tokens.groundAlt },
        "&:hover a": { textDecoration: "underline" },
      }}
    >
      <Box sx={{ minWidth: 0 }}>
        <TextLink
          to="/interviews/$interviewId"
          params={{ interviewId: interview.id }}
          underline="none"
          color="inherit"
          sx={{
            typography: "subtitle1",
            lineHeight: 1.35,
            "&::after": { content: '""', position: "absolute", inset: 0 },
          }}
        >
          {interview.title}
        </TextLink>
        <Box sx={{ mt: 0.5, "&:empty": { display: "none" } }}>
          <InterviewChips interview={interview} />
        </Box>
      </Box>
      {/* On phones the details run on one line under the title. */}
      <Typography sx={{ ...cell, display: { md: "none" } }}>
        {[
          interview.interviewee ?? "Unknown interviewee",
          interview.primary_language?.name,
          length,
          recorded,
        ]
          .filter(Boolean)
          .join(" · ")}
      </Typography>
      <Typography sx={{ ...cell, display: { xs: "none", md: "block" } }}>
        <Box component="span" sx={visuallyHidden}>
          Interviewee:{" "}
        </Box>
        {interview.interviewee ?? "Unknown"}
      </Typography>
      <Typography sx={{ ...cell, display: { xs: "none", md: "block" } }}>
        {interview.primary_language?.name ?? "—"}
      </Typography>
      <Typography sx={{ ...cell, display: { xs: "none", md: "block" }, textAlign: "right" }}>
        <Box component="span" sx={visuallyHidden}>
          Length:{" "}
        </Box>
        {length ?? "—"}
      </Typography>
      <Typography sx={{ ...cell, display: { xs: "none", md: "block" } }}>
        <Box component="span" sx={visuallyHidden}>
          Recorded:{" "}
        </Box>
        {recorded ?? "Unknown"}
      </Typography>
    </Box>
  );
}
