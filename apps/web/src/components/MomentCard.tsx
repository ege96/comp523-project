import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useId } from "react";

import type { Moment } from "../api/schemas";
import { formatClock, formatRecordedOn, transcriptLabel } from "../format";
import { PlayIcon } from "./icons";
import { InterviewChips } from "./InterviewChips";
import { ButtonLink } from "./links";
import { LinePair } from "./LinePair";

export function MomentCard({ moment }: { moment: Moment }) {
  const { interview, excerpt } = moment;
  const titleId = useId();
  const recorded = formatRecordedOn(interview);
  const details = [
    interview.interviewee ?? "Unknown interviewee",
    interview.primary_language?.name,
    recorded ? `Recorded ${recorded}` : null,
  ].filter(Boolean);
  // Semantic alone means the words themselves may not appear.
  const relatedOnly = !moment.matched_by.includes("keyword");
  const start = formatClock(moment.start_ms);

  return (
    <Paper component="article" aria-labelledby={titleId} sx={{ p: { xs: 2, sm: 3 } }}>
      <Stack spacing={1.5}>
        <Stack
          direction="row"
          spacing={2}
          useFlexGap
          sx={{ alignItems: "center", flexWrap: "wrap", rowGap: 1 }}
        >
          <ButtonLink
            to="/interviews/$interviewId"
            params={{ interviewId: interview.id }}
            search={{ t: moment.start_ms }}
            variant="outlined"
            size="small"
            startIcon={<PlayIcon aria-hidden />}
            // The accessible name starts with the visible words (WCAG 2.5.3 label in name).
            aria-label={`Open at ${start}, ${interview.title}`}
            sx={{ fontVariantNumeric: "tabular-nums" }}
          >
            Open at {start}
          </ButtonLink>
          {relatedOnly ? (
            <Typography variant="caption" color="text.secondary">
              Related by meaning
            </Typography>
          ) : null}
        </Stack>
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
        <Box sx={{ borderTop: 1, borderColor: "divider", pt: 1.25 }}>
          <Typography variant="body2" color="text.secondary">
            <Box
              component="span"
              id={titleId}
              sx={{ color: "text.primary", fontWeight: 600, mr: 0.75 }}
            >
              {interview.title}
            </Box>
            · {details.join(" · ")}
          </Typography>
          {interview.visibility === "private" || transcriptLabel(interview.status) ? (
            <Box sx={{ mt: 0.75 }}>
              <InterviewChips interview={interview} />
            </Box>
          ) : null}
        </Box>
      </Stack>
    </Paper>
  );
}
