import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import Container from "@mui/material/Container";
import Paper from "@mui/material/Paper";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import Typography from "@mui/material/Typography";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useRef, useState } from "react";

import { ApiError, interviewQueries } from "../api/client";
import type { InterviewDetail, Segment } from "../api/schemas";
import { useAuth } from "../auth/useAuth";
import { InterviewChips } from "../components/InterviewChips";
import { formatClock, formatRecordedOn } from "../format";

const route = getRouteApi("/interviews/$interviewId");

export function InterviewPage() {
  const { interviewId } = route.useParams();
  // Set when opened from a search result: start there and point out that line.
  const { t } = route.useSearch();
  const { viewer } = useAuth();
  // Both requests start together rather than one waiting on the other.
  const interview = useQuery({
    ...interviewQueries.detail(viewer, interviewId),
    enabled: viewer.ready,
  });
  const segments = useQuery({
    ...interviewQueries.segments(viewer, interviewId),
    enabled: viewer.ready,
  });
  const player = useRef<HTMLMediaElement>(null);

  if (interview.isError) {
    // A Private interview is a 404 for visitors, the same as one that doesn't exist.
    const missing = interview.error instanceof ApiError && interview.error.status === 404;
    return (
      <Container sx={{ py: 6 }}>
        <Alert severity={missing ? "info" : "error"}>
          {missing
            ? "This interview doesn't exist, or isn't public."
            : "This interview couldn't be loaded. Please try again."}
        </Alert>
      </Container>
    );
  }
  if (interview.isPending) {
    return (
      <Container sx={{ py: 6 }}>
        <Skeleton variant="text" width="60%" height={64} />
        <Skeleton variant="rounded" height={320} />
      </Container>
    );
  }

  const seek = (ms: number) => {
    if (!player.current) return;
    player.current.currentTime = ms / 1000;
    void player.current.play().catch(() => undefined); // autoplay can be refused; seeking still worked
  };

  return (
    <Container sx={{ py: 6 }}>
      <Stack spacing={1} sx={{ mb: 4 }}>
        <Typography variant="h1">{interview.data.title}</Typography>
        <Typography color="text.secondary">{summaryLine(interview.data)}</Typography>
        <InterviewChips interview={interview.data} />
      </Stack>
      <Box
        sx={{
          display: "grid",
          gap: 4,
          gridTemplateColumns: { md: "1fr 1fr" },
          alignItems: "start",
        }}
      >
        <Stack spacing={3}>
          <Player interview={interview.data} startMs={t} ref={player} />
          <AboutRecording interview={interview.data} />
        </Stack>
        <Paper sx={{ p: 3 }}>
          <Typography variant="h3" gutterBottom>
            Transcript
          </Typography>
          {segments.isError ? (
            <Alert severity="error">The transcript couldn&apos;t be loaded.</Alert>
          ) : segments.isPending ? (
            <Skeleton variant="rounded" height={240} />
          ) : (
            <Transcript
              segments={segments.data.items}
              translation={interview.data.translation_status}
              onSeek={seek}
              highlightMs={t}
            />
          )}
        </Paper>
      </Box>
    </Container>
  );
}

function summaryLine(interview: InterviewDetail): string {
  const recorded = formatRecordedOn(interview);
  return [
    interview.interviewee ?? "Unknown interviewee",
    interview.primary_language?.name,
    recorded ? `Recorded ${recorded}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function Player({
  interview,
  startMs,
  ref,
}: {
  interview: InterviewDetail;
  startMs: number | undefined;
  ref: React.Ref<HTMLMediaElement>;
}) {
  const media = interview.media;
  if (!media) {
    return <Alert severity="info">The recording is still being prepared for playback.</Alert>;
  }
  // A media fragment (#t=seconds) makes the browser start there, with no effect to run.
  const src = startMs === undefined ? media.url : `${media.url}#t=${String(startMs / 1000)}`;
  // Media links are signed and expire (P-024); the API issues a fresh one on each load.
  return media.content_type.startsWith("video/") ? (
    <Box
      component="video"
      ref={ref}
      src={src}
      controls
      preload="metadata"
      sx={{ width: "100%", bgcolor: "black" }}
    />
  ) : (
    <Box component="audio" ref={ref} src={src} controls preload="metadata" sx={{ width: "100%" }} />
  );
}

function AboutRecording({ interview }: { interview: InterviewDetail }) {
  const rows: [string, string | null][] = [
    ["Interviewee", interview.interviewee],
    ["Interviewer", interview.interviewer],
    ["Location", interview.location],
    ["Languages", interview.languages.map((l) => l.name).join(", ") || null],
    ["Length", interview.duration_ms === null ? null : formatClock(interview.duration_ms)],
  ];
  return (
    <Stack spacing={1}>
      <Typography variant="h3">About this recording</Typography>
      {interview.description ? <Typography>{interview.description}</Typography> : null}
      <Box
        component="dl"
        sx={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: 1, columnGap: 3, m: 0 }}
      >
        {rows.map(([label, value]) =>
          value ? (
            <Box key={label} sx={{ display: "contents" }}>
              <Typography component="dt" color="text.secondary">
                {label}
              </Typography>
              <Typography component="dd" sx={{ m: 0 }}>
                {value}
              </Typography>
            </Box>
          ) : null,
        )}
      </Box>
      {interview.consent_note ? (
        <Typography variant="body2" color="text.secondary">
          {interview.consent_note}
        </Typography>
      ) : null}
      {interview.status_detail ? <Alert severity="info">{interview.status_detail}</Alert> : null}
    </Stack>
  );
}

const translationMissing = {
  not_needed: "This interview is in English.",
  pending: "The English translation is still being made.",
  failed: "An English translation isn't available for this interview.",
  done: null,
} as const;

function Transcript({
  segments,
  translation,
  onSeek,
  highlightMs,
}: {
  segments: Segment[];
  translation: InterviewDetail["translation_status"];
  onSeek: (ms: number) => void;
  highlightMs: number | undefined;
}) {
  const [tab, setTab] = useState<"original" | "english">("original");
  const scrolled = useRef(false);
  // Brings the highlighted line into view once, when it first renders.
  const scrollToHighlight = (el: HTMLElement | null) => {
    if (!el || scrolled.current) return;
    scrolled.current = true;
    el.scrollIntoView({ block: "center" });
  };
  if (segments.length === 0) {
    return <Typography color="text.secondary">No transcript yet.</Typography>;
  }
  const englishNote = tab === "english" ? translationMissing[translation] : null;
  return (
    <>
      <Tabs
        value={tab}
        onChange={(_, value: "original" | "english") => {
          setTab(value);
        }}
        sx={{ mb: 2 }}
      >
        <Tab value="original" label="Original" />
        <Tab value="english" label="English" />
      </Tabs>
      {englishNote ? (
        <Typography color="text.secondary">{englishNote}</Typography>
      ) : (
        <Stack component="ol" sx={{ listStyle: "none", p: 0, m: 0 }}>
          {segments.map((s) => {
            const highlighted =
              highlightMs !== undefined && highlightMs >= s.start_ms && highlightMs < s.end_ms;
            // content-visibility lets the browser skip laying out segments that are off screen.
            return (
              <Box
                component="li"
                key={s.seq}
                ref={highlighted ? scrollToHighlight : undefined}
                aria-current={highlighted ? "true" : undefined}
                sx={{
                  display: "flex",
                  gap: 2,
                  py: 1.5,
                  px: 1,
                  mx: -1,
                  borderRadius: 1,
                  bgcolor: highlighted ? "rgba(150, 58, 53, 0.08)" : undefined,
                  contentVisibility: "auto",
                  containIntrinsicSize: "auto 3rem",
                }}
              >
                <ButtonBase
                  onClick={() => {
                    onSeek(s.start_ms);
                  }}
                  aria-label={`Play from ${formatClock(s.start_ms)}`}
                  sx={{
                    color: "primary.main",
                    alignSelf: "start",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {formatClock(s.start_ms)}
                </ButtonBase>
                <Typography>
                  {tab === "english" ? (s.english_text ?? s.original_text) : s.original_text}
                </Typography>
              </Box>
            );
          })}
        </Stack>
      )}
    </>
  );
}
