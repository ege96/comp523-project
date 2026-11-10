import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

import type { Moment } from "../api/schemas";
import { formatClock, formatRecordedOn } from "../format";
import { tokens } from "../theme";
import { PlayIcon } from "./icons";
import { InterviewChips } from "./InterviewChips";
import { TextLink } from "./links";
import { LinePair } from "./LinePair";

/**
 * One search hit: a stretch of transcript, opened in the viewer at its first line. The time
 * sits on a small blue plate in the margin and is the link; the spoken words lead the entry.
 */
export function MomentCard({ moment }: { moment: Moment }) {
  const { interview, excerpt } = moment;
  const recorded = formatRecordedOn(interview);
  const details = [
    interview.interviewee ?? "Unknown interviewee",
    interview.primary_language?.name,
    recorded ? `Recorded ${recorded}` : null,
  ].filter(Boolean);
  // Semantic alone means the words themselves may not appear (search API, PR #27).
  const relatedOnly = !moment.matched_by.includes("keyword");
  const start = formatClock(moment.start_ms);

  return (
    <Box
      component="article"
      sx={{
        position: "relative",
        display: "grid",
        gridTemplateColumns: { xs: "1fr", sm: "6.5rem minmax(0, 1fr)" },
        columnGap: 3,
        rowGap: 1.5,
        py: 3,
        borderBottom: 1,
        borderColor: "divider",
      }}
    >
      <TextLink
        to="/interviews/$interviewId"
        params={{ interviewId: interview.id }}
        search={{ t: moment.start_ms }}
        underline="none"
        aria-label={`Open ${interview.title} at ${start}`}
        sx={{
          alignSelf: "start",
          justifySelf: "start",
          display: "flex",
          flexDirection: { xs: "row", sm: "column" },
          alignItems: { xs: "baseline", sm: "flex-start" },
          gap: { xs: 1, sm: 0 },
          minWidth: { sm: "6.5rem" },
          px: 1.5,
          py: { xs: 0.75, sm: 1 },
          bgcolor: tokens.plate,
          color: tokens.onPlate,
          borderRadius: 1,
          fontVariantNumeric: "tabular-nums",
          "&:hover": { bgcolor: tokens.plateDeep },
        }}
      >
        <Box component="span" sx={{ fontSize: "1.25rem", fontWeight: 800, lineHeight: 1.2 }}>
          {start}
        </Box>
        <Box component="span" sx={{ fontSize: "0.8125rem", color: tokens.onPlateMuted }}>
          to {formatClock(moment.end_ms)}
        </Box>
        <Box
          component="span"
          sx={{
            display: "inline-flex",
            alignItems: "center",
            gap: 0.5,
            fontSize: "0.8125rem",
            fontWeight: 600,
            mt: { sm: 1 },
            ml: { xs: "auto", sm: 0 },
          }}
        >
          <PlayIcon sx={{ fontSize: "0.875rem" }} aria-hidden />
          Listen
        </Box>
      </TextLink>

      <Stack spacing={1.5} sx={{ minWidth: 0 }}>
        <Box>
          <Typography variant="subtitle1" component="h3" sx={{ lineHeight: 1.35 }}>
            {interview.title}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {details.join(" · ")}
          </Typography>
        </Box>
        <InterviewChips interview={interview} />
        <Stack component="blockquote" spacing={1.25} sx={{ m: 0 }}>
          {excerpt.map((s) => (
            <LinePair
              key={s.seq}
              original={s.original_text}
              english={s.english_text}
              lang={s.language}
            />
          ))}
        </Stack>
        {relatedOnly ? (
          <Typography variant="caption" color="text.secondary">
            Related in meaning. Your exact words may not appear here.
          </Typography>
        ) : null}
      </Stack>
    </Box>
  );
}
