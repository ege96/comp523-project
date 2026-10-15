import Chip from "@mui/material/Chip";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

import type { Moment } from "../api/schemas";
import { formatClock, formatRecordedOn } from "../format";
import { PlayIcon } from "./icons";
import { InterviewChips } from "./InterviewChips";
import { ButtonLink } from "./links";

/** One search hit: a stretch of transcript, opened in the viewer at its first line. */
export function MomentCard({ moment }: { moment: Moment }) {
  const { interview, excerpt } = moment;
  const recorded = formatRecordedOn(interview);
  const details = [
    interview.interviewee ?? "Unknown interviewee",
    interview.primary_language?.name,
    recorded ? `Recorded ${recorded}` : null,
  ].filter(Boolean);
  const english = excerpt.flatMap((s) => (s.english_text ? [s.english_text] : [])).join(" ");
  // Semantic alone means the words themselves may not appear (search API, PR #27).
  const relatedOnly = !moment.matched_by.includes("keyword");
  const span = `${formatClock(moment.start_ms)} – ${formatClock(moment.end_ms)}`;

  return (
    <Paper component="article" sx={{ p: 3 }}>
      <Stack spacing={1.5}>
        <Stack
          direction="row"
          spacing={2}
          sx={{ justifyContent: "space-between", alignItems: "flex-start" }}
        >
          <Typography variant="h3" component="h2">
            {interview.title}
          </Typography>
          <Chip
            size="small"
            label={span}
            aria-label={`From ${span}`}
            sx={{ bgcolor: "rgba(150, 58, 53, 0.1)", color: "primary.main", flexShrink: 0 }}
          />
        </Stack>
        <Typography variant="body2" color="text.secondary">
          {details.join(" · ")}
        </Typography>
        <InterviewChips interview={interview} />
        <Stack component="blockquote" spacing={1} sx={{ m: 0 }}>
          {english ? <Typography>“{english}”</Typography> : null}
          {/* The original words, always kept; `lang` lets the browser pick a Devanagari font. */}
          <Stack spacing={0.5}>
            {excerpt.map((s) => (
              <Typography
                key={s.seq}
                lang={s.language ?? undefined}
                variant={english ? "body2" : "body1"}
                color={english ? "text.secondary" : "text.primary"}
              >
                {s.original_text}
              </Typography>
            ))}
          </Stack>
        </Stack>
        {relatedOnly ? (
          <Typography variant="caption" color="text.secondary">
            Related in meaning. Your exact words may not appear here.
          </Typography>
        ) : null}
        <ButtonLink
          to="/interviews/$interviewId"
          params={{ interviewId: interview.id }}
          search={{ t: moment.start_ms }}
          variant="outlined"
          endIcon={<PlayIcon />}
          aria-label={`Open ${interview.title} at ${formatClock(moment.start_ms)}`}
          sx={{ alignSelf: "flex-start" }}
        >
          Open at this moment
        </ButtonLink>
      </Stack>
    </Paper>
  );
}
