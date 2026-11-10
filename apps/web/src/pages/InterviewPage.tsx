import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import ButtonBase from "@mui/material/ButtonBase";
import Container from "@mui/material/Container";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useRef, useState } from "react";

import { ApiError, interviewQueries } from "../api/client";
import type { InterviewDetail, Segment } from "../api/schemas";
import { useAuth } from "../auth/useAuth";
import { SearchIcon } from "../components/icons";
import { InterviewChips } from "../components/InterviewChips";
import { LinePair } from "../components/LinePair";
import { TextLink } from "../components/links";
import { formatClock, formatRecordedOn } from "../format";
import { tokens } from "../theme";
import { finder, hasMatch, splitMatches } from "../transcriptFind";

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
  // Where playback is, in ms; null until the recording has played.
  const [playingMs, setPlayingMs] = useState<number | null>(null);

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
        <Skeleton variant="rectangular" height={320} />
      </Container>
    );
  }

  const seek = (ms: number) => {
    if (!player.current) return;
    player.current.currentTime = ms / 1000;
    void player.current.play().catch(() => undefined); // autoplay can be refused; seeking still worked
  };
  const video = interview.data.media?.content_type.startsWith("video/") ?? false;

  return (
    <Container sx={{ pt: { xs: 3, md: 5 } }}>
      <Stack spacing={1} sx={{ mb: { xs: 2, md: 4 }, maxWidth: "48rem" }}>
        <Typography
          variant="h1"
          sx={{ fontSize: { xs: "1.75rem", md: "2.25rem" }, textWrap: "balance" }}
        >
          {interview.data.title}
        </Typography>
        <Typography color="text.secondary">{summaryLine(interview.data)}</Typography>
        <InterviewChips interview={interview.data} />
      </Stack>
      {/* Phones: one column, the player pinned while the transcript scrolls (audio only: a
          pinned video would cover the text). Wide screens: player and details in a pinned
          side column. The aside dissolves into the column on phones so the player can pin. */}
      <Box
        sx={{
          display: { xs: "block", md: "grid" },
          columnGap: 6,
          gridTemplateColumns: "minmax(0, 20rem) minmax(0, 1fr)",
          alignItems: "start",
        }}
      >
        <Box
          component="aside"
          aria-label="Recording"
          sx={{ display: { xs: "contents", md: "block" }, position: "sticky", top: 24 }}
        >
          <Box
            sx={{
              position: { xs: video ? "static" : "sticky", md: "static" },
              top: 0,
              zIndex: 2,
              mx: { xs: -2, sm: -3, md: 0 },
            }}
          >
            <Player
              interview={interview.data}
              startMs={t}
              ref={player}
              onTime={(ms) => {
                setPlayingMs(ms);
              }}
            />
          </Box>
          <Box sx={{ mt: { xs: 3, md: 4 }, mb: { xs: 4, md: 0 } }}>
            <AboutRecording interview={interview.data} />
          </Box>
        </Box>
        <Box component="section" aria-labelledby="transcript" sx={{ minWidth: 0 }}>
          <Typography
            variant="overline"
            component="h2"
            id="transcript"
            sx={{ display: "block", borderBottom: 2, borderColor: "text.primary", pb: 0.5 }}
          >
            Transcript
          </Typography>
          {segments.isError ? (
            <Alert severity="error" sx={{ mt: 2 }}>
              The transcript couldn&apos;t be loaded.
            </Alert>
          ) : segments.isPending ? (
            <Skeleton variant="rectangular" height={240} sx={{ mt: 2 }} />
          ) : (
            <Transcript
              segments={segments.data.items}
              translation={interview.data.translation_status}
              onSeek={seek}
              highlightMs={t}
              playingMs={playingMs}
            />
          )}
        </Box>
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
  onTime,
}: {
  interview: InterviewDetail;
  startMs: number | undefined;
  ref: React.Ref<HTMLMediaElement>;
  onTime: (ms: number) => void;
}) {
  const media = interview.media;
  if (!media) {
    return <Alert severity="info">The recording is still being prepared for playback.</Alert>;
  }
  // A media fragment (#t=seconds) makes the browser start there, with no effect to run.
  const src = startMs === undefined ? media.url : `${media.url}#t=${String(startMs / 1000)}`;
  // Media links are signed and expire (P-024); the API issues a fresh one on each load.
  const props = {
    ref,
    src,
    controls: true,
    preload: "metadata",
    // Only while playing: loading the media also fires a time update, at 0.
    onTimeUpdate: (e: React.SyntheticEvent<HTMLMediaElement>) => {
      if (!e.currentTarget.paused) onTime(Math.round(e.currentTarget.currentTime * 1000));
    },
  } as const;
  return (
    <Box sx={{ bgcolor: tokens.plate, p: { xs: 1, md: 1.5 }, borderRadius: { md: "2px" } }}>
      {media.content_type.startsWith("video/") ? (
        <Box
          component="video"
          {...props}
          sx={{ display: "block", width: "100%", bgcolor: "black" }}
        />
      ) : (
        <Box component="audio" {...props} sx={{ display: "block", width: "100%", height: 44 }} />
      )}
    </Box>
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
    <Stack spacing={1.5}>
      <Typography
        variant="overline"
        component="h2"
        sx={{ borderBottom: 2, borderColor: "text.primary", pb: 0.5 }}
      >
        About this recording
      </Typography>
      {interview.description ? (
        <Typography variant="body2">{interview.description}</Typography>
      ) : null}
      <Box
        component="dl"
        sx={{
          display: "grid",
          gridTemplateColumns: "max-content 1fr",
          columnGap: 2,
          rowGap: 0.75,
          m: 0,
          typography: "body2",
        }}
      >
        {rows.map(([label, value]) =>
          value ? (
            <Box key={label} sx={{ display: "contents" }}>
              <Box component="dt" sx={{ color: "text.secondary" }}>
                {label}
              </Box>
              <Box component="dd" sx={{ m: 0 }}>
                {value}
              </Box>
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

type View = "both" | "original" | "english";

function Transcript({
  segments,
  translation,
  onSeek,
  highlightMs,
  playingMs,
}: {
  segments: Segment[];
  translation: InterviewDetail["translation_status"];
  onSeek: (ms: number) => void;
  highlightMs: number | undefined;
  playingMs: number | null;
}) {
  // Original and English together when there is a translation: reading them side by side is
  // the point of a bilingual archive.
  const [tab, setTab] = useState<View>(translation === "done" ? "both" : "original");
  const [query, setQuery] = useState("");
  // Which of the matching lines is the current one.
  const [current, setCurrent] = useState(0);
  const scrolled = useRef(false);
  const lineRefs = useRef(new Map<number, HTMLElement>());
  const lastPlaying = useRef<number | null>(null);
  // Brings the highlighted line into view once, when it first renders.
  const scrollToHighlight = (el: HTMLElement | null) => {
    if (!el || scrolled.current) return;
    scrolled.current = true;
    el.scrollIntoView({ block: "center" });
  };
  if (segments.length === 0) {
    return (
      <Typography color="text.secondary" sx={{ mt: 2 }}>
        No transcript yet.
      </Typography>
    );
  }
  const englishNote = tab === "english" ? translationMissing[translation] : null;
  const texts = (s: Segment, t: View): string[] =>
    t === "english"
      ? [s.english_text ?? s.original_text]
      : t === "original" || s.english_text === null
        ? [s.original_text]
        : [s.original_text, s.english_text];
  const corrected = (s: Segment) =>
    tab === "english" && s.english_text !== null
      ? s.english_edited
      : tab === "original"
        ? s.original_edited
        : s.original_edited || (s.english_text !== null && s.english_edited);
  const anyCorrected = segments.some(corrected);

  const re = finder(query);
  const matchesFor = (q: string, t: View) => {
    const r = finder(q);
    return segments.filter((s) => texts(s, t).some((x) => hasMatch(x, r))).map((s) => s.seq);
  };
  const matches = matchesFor(query, tab);
  const currentSeq = matches[Math.min(current, matches.length - 1)];
  // Scrolling happens in the handlers, since every line is already on the page.
  const goTo = (seqs: number[], index: number) => {
    const wrapped = seqs.length ? (index + seqs.length) % seqs.length : 0;
    setCurrent(wrapped);
    const seq = seqs[wrapped];
    if (seq !== undefined) lineRefs.current.get(seq)?.scrollIntoView({ block: "center" });
  };

  // "You are here": the playing line once the recording plays, else the line opened at.
  const hereMs = playingMs ?? highlightMs;
  const hereSeq =
    hereMs === undefined
      ? undefined
      : segments.find((s) => hereMs >= s.start_ms && hereMs < s.end_ms)?.seq;
  // Follow playback only while the reader is following it: if the line that was playing is
  // on screen, keep the new one in view; if they scrolled away to read, leave them there.
  const followPlayback = (seq: number, el: HTMLElement) => {
    if (playingMs === null || lastPlaying.current === seq) return;
    const previous =
      lastPlaying.current === null ? null : lineRefs.current.get(lastPlaying.current);
    lastPlaying.current = seq;
    if (!previous) return;
    const box = previous.getBoundingClientRect();
    if (box.bottom > 0 && box.top < window.innerHeight) el.scrollIntoView({ block: "nearest" });
  };
  const mark = (text: string) =>
    splitMatches(text, re).map((part, i) =>
      part.match ? <mark key={i}>{part.text}</mark> : part.text,
    );

  return (
    <>
      <Tabs
        value={tab}
        onChange={(_, value: View) => {
          setTab(value);
          goTo(matchesFor(query, value), 0);
        }}
        aria-label="Transcript language"
        sx={{ mb: 2, borderBottom: 1, borderColor: "divider" }}
      >
        {translation === "done" ? <Tab value="both" label="Original + English" /> : null}
        <Tab value="original" label="Original" />
        <Tab value="english" label="English" />
      </Tabs>
      {englishNote ? (
        <Typography color="text.secondary">{englishNote}</Typography>
      ) : (
        <>
          {/* There's no manual review step, so every transcript carries this note. */}
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2, maxWidth: "65ch" }}>
            {tab === "original" ? "Transcribed" : "Transcribed and translated"} by machine, so it
            may contain errors.
            {anyCorrected ? " Lines marked “Corrected” were fixed by the archive team." : null}{" "}
            <TextLink to="/about" hash="machine-transcripts" color="inherit">
              Learn more
            </TextLink>
          </Typography>
          <Stack
            direction="row"
            spacing={1}
            role="search"
            aria-label="Find in transcript"
            sx={{
              mb: 1,
              pt: 1.5,
              pb: 1,
              borderBottom: 1,
              borderColor: "divider",
              alignItems: "center",
              flexWrap: "wrap",
              rowGap: 1,
              position: { md: "sticky" },
              top: { md: 0 },
              zIndex: 1,
              bgcolor: "background.default",
            }}
          >
            <TextField
              size="small"
              label="Find in transcript"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                goTo(matchesFor(e.target.value, tab), 0);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  goTo(matches, current + (e.shiftKey ? -1 : 1));
                } else if (e.key === "Escape") {
                  setQuery("");
                }
              }}
              slotProps={{
                input: { startAdornment: <SearchIcon fontSize="small" sx={{ mr: 1 }} /> },
                htmlInput: { type: "search" },
              }}
              sx={{ flex: "1 1 14rem" }}
            />
            {re ? (
              <>
                <Typography
                  variant="body2"
                  color="text.secondary"
                  role="status"
                  sx={{ minWidth: "7rem" }}
                >
                  {matches.length
                    ? `${String(Math.min(current, matches.length - 1) + 1)} of ${String(matches.length)} lines`
                    : "No lines match"}
                </Typography>
                <Button
                  size="small"
                  disabled={matches.length < 2}
                  onClick={() => {
                    goTo(matches, current - 1);
                  }}
                >
                  Previous
                </Button>
                <Button
                  size="small"
                  disabled={matches.length < 2}
                  onClick={() => {
                    goTo(matches, current + 1);
                  }}
                >
                  Next
                </Button>
              </>
            ) : null}
          </Stack>
          <Box component="ol" sx={{ listStyle: "none", p: 0, m: 0 }}>
            {segments.map((s) => {
              const here = s.seq === hereSeq;
              const isCurrent = s.seq === currentSeq;
              return (
                <Box
                  component="li"
                  key={s.seq}
                  ref={(el: HTMLElement | null) => {
                    if (el) lineRefs.current.set(s.seq, el);
                    else lineRefs.current.delete(s.seq);
                    if (here && hereMs === highlightMs) scrollToHighlight(el);
                    if (here && el) followPlayback(s.seq, el);
                  }}
                  aria-current={here ? "true" : undefined}
                  sx={{
                    display: "grid",
                    gridTemplateColumns: "4.25rem minmax(0, 1fr)",
                    columnGap: { xs: 1.5, sm: 2 },
                    py: 1.5,
                    borderBottom: 1,
                    borderColor: "divider",
                    outline: isCurrent ? `2px solid ${tokens.plate}` : undefined,
                    outlineOffset: -2,
                    scrollMarginTop: { xs: 96, md: 72 },
                    // Lets the browser skip laying out lines that are off screen.
                    contentVisibility: "auto",
                    containIntrinsicSize: "auto 4rem",
                  }}
                >
                  <ButtonBase
                    onClick={() => {
                      onSeek(s.start_ms);
                    }}
                    aria-label={`Play from ${formatClock(s.start_ms)}`}
                    sx={{
                      alignSelf: "start",
                      justifySelf: "start",
                      mt: "3px",
                      px: 0.75,
                      py: 0.25,
                      borderRadius: "2px",
                      fontWeight: 600,
                      fontSize: "0.9375rem",
                      fontVariantNumeric: "tabular-nums",
                      color: here ? tokens.onPlate : tokens.plate,
                      bgcolor: here ? tokens.here : "transparent",
                      transition: "background-color 160ms ease-out, color 160ms ease-out",
                      "&:hover": { bgcolor: here ? tokens.here : tokens.groundAlt },
                      "&.Mui-focusVisible": {
                        outline: `2px solid ${tokens.plate}`,
                        outlineOffset: 2,
                      },
                    }}
                  >
                    {formatClock(s.start_ms)}
                  </ButtonBase>
                  <Box sx={{ minWidth: 0 }}>
                    <LinePair
                      original={s.original_text}
                      english={s.english_text}
                      lang={s.language}
                      show={tab}
                      renderText={mark}
                    />
                    {corrected(s) ? (
                      <Typography variant="caption" color="text.secondary">
                        Corrected
                      </Typography>
                    ) : null}
                  </Box>
                </Box>
              );
            })}
          </Box>
        </>
      )}
    </>
  );
}
