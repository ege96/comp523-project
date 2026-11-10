import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

import type { Moment } from "../api/schemas";
import { formatClock, formatRecordedOn } from "../format";
import { PlayIcon } from "./icons";
import { InterviewChips } from "./InterviewChips";
import { Pill } from "./Pill";
import { ButtonLink } from "./links";
import { LinePair } from "./LinePair";
import { visuallyHidden } from "./visuallyHidden";

/**
 * One search hit, as a card like the search mockup: the interview, the time of the moment, the
 * spoken words (original above English), and a button that opens the viewer at that time.
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
    <Paper component="article" sx={{ p: { xs: 2, sm: 3 } }}>
      <Stack spacing={1.5}>
        <Stack
          direction="row"
          spacing={2}
          sx={{ justifyContent: "space-between", alignItems: "flex-start" }}
        >
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="h3" sx={{ fontSize: { xs: "1.1875rem", sm: "1.3125rem" } }}>
              {interview.title}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              {details.join(" · ")}
            </Typography>
          </Box>
          <Pill tone="terracotta" numeric>
            <Box component="span" sx={visuallyHidden}>
              From{" "}
            </Box>
            {start} – {formatClock(moment.end_ms)}
          </Pill>
        </Stack>
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
        <Stack
          direction={{ xs: "column", sm: "row" }}
          spacing={{ xs: 1, sm: 2 }}
          sx={{ alignItems: { sm: "center" }, pt: 0.5 }}
        >
          <ButtonLink
            to="/interviews/$interviewId"
            params={{ interviewId: interview.id }}
            search={{ t: moment.start_ms }}
            variant="outlined"
            endIcon={<PlayIcon aria-hidden />}
            aria-label={`Open ${interview.title} at ${start}`}
            sx={{ alignSelf: "flex-start" }}
          >
            Open at this moment
          </ButtonLink>
          {relatedOnly ? (
            <Typography variant="caption" color="text.secondary">
              Related in meaning. Your exact words may not appear here.
            </Typography>
          ) : null}
        </Stack>
      </Stack>
    </Paper>
  );
}
