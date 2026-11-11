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
import useMediaQuery from "@mui/material/useMediaQuery";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useLocation } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiError, interviewQueries } from "../api/client";
import type { InterviewDetail, Segment } from "../api/schemas";
import { useAuth } from "../auth/useAuth";
import { englishText, toVtt } from "../captions";
import { ArrowBackIcon, EditIcon, SearchIcon } from "../components/icons";
import { InterviewChips } from "../components/InterviewChips";
import { LinePair } from "../components/LinePair";
import { ButtonLink, TextLink } from "../components/links";
import { formatClock, formatRecordedOn } from "../format";
import { searchOrigin } from "../searchOrigin";
import { theme, tokens } from "../theme";
import { finder, hasMatch, splitMatches } from "../transcriptFind";

const route = getRouteApi("/interviews/$interviewId");

const NO_SEGMENTS: Segment[] = [];

export function InterviewPage() {
  const { interviewId } = route.useParams();
  // Set when opened from a search result or a shared link: start there, point out that line.
  const { t } = route.useSearch();
  const navigate = route.useNavigate();
  // The results this was opened from, for "Back to results"; none on a direct visit.
  const origin = searchOrigin(useLocation());
  const { viewer, state: auth } = useAuth();
  const isAdmin = auth.status === "signedIn" && auth.role === "admin";
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
  // The line playback is in; null until the recording has played or been moved. Clock ticks
  // inside the same line leave it unchanged, so they cost no re-render.
  const [playing, setPlaying] = useState<{ seq: number | undefined; ms: number } | null>(null);
  // The player starts where the page was opened; a later ?t= (a line's time clicked) must
  // not reload the recording.
  const [startMs] = useState(t);
  const [mediaFailed, setMediaFailed] = useState(false);
  // Phones pin the audio player above the transcript; the find bar pins just below it.
  const [pinHeight, setPinHeight] = useState(0);
  const measurePin = useCallback((el: HTMLElement | null) => {
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      setPinHeight(el.offsetHeight);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, []);

  // A Private interview is a 404 for visitors, the same as one that doesn't exist, even when
  // it was loaded before. Any other failure of a refresh leaves what was loaded in place.
  const missing =
    interview.isError && interview.error instanceof ApiError && interview.error.status === 404;
  if (interview.isError && (missing || interview.data === undefined)) {
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

  // A line's time: the URL points at it (replacing, not adding history), and the recording
  // plays from there when there is one.
  const goToLine = (ms: number) => {
    void navigate({ search: { t: ms }, replace: true });
    const el = player.current;
    if (!el) return;
    el.currentTime = ms / 1000;
    el.play().catch((error: unknown) => {
      // The browser may refuse to autoplay, or a later click interrupts this one; seeking
      // still worked. Anything else means the recording itself can't play.
      const benign =
        error instanceof DOMException &&
        (error.name === "NotAllowedError" || error.name === "AbortError");
      if (!benign || el.error) setMediaFailed(true);
    });
  };
  const media = interview.data.media;
  const video = media?.content_type.startsWith("video/") ?? false;
  // Only an audio player pins on phones: a pinned video, or a notice, would cover the text.
  const pinned = media !== null && !video;
  const lines = segments.data?.items ?? NO_SEGMENTS;
  const lineAt = (ms: number) => lines.find((s) => ms >= s.start_ms && ms < s.end_ms);
  // The line a shared link opens at: the one playing, else the one the page opened at.
  const hereLine = playing
    ? lines.find((s) => s.seq === playing.seq)
    : t === undefined
      ? undefined
      : lineAt(t);
  const linkMs = hereLine?.start_ms ?? playing?.ms ?? t ?? 0;

  return (
    <Container sx={{ pt: { xs: 2, md: 4 } }}>
      <Stack
        direction="row"
        spacing={2}
        useFlexGap
        sx={{
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          mb: { xs: 1.5, md: 2 },
        }}
      >
        <TextLink
          {...(origin ? { to: "/search", search: origin } : { to: "/interviews" })}
          underline="hover"
          sx={{ display: "inline-flex", alignItems: "center", gap: 0.5 }}
        >
          <ArrowBackIcon fontSize="small" aria-hidden />
          {origin ? "Back to results" : "All interviews"}
        </TextLink>
        {/* Admins reading the public page can jump straight to fixing it. */}
        {isAdmin ? (
          <ButtonLink
            to="/admin/interviews/$interviewId"
            params={{ interviewId }}
            variant="outlined"
            size="small"
            startIcon={<EditIcon aria-hidden />}
          >
            Edit in Upload &amp; review
          </ButtonLink>
        ) : null}
      </Stack>
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
          pinned video would cover the text). Wide screens: player and details in a side
          column as tall as the transcript, where only the player stays pinned, so long
          details never end up out of reach below the screen. The aside dissolves into the
          column on phones so the player can pin. */}
      <Box
        sx={{
          display: { xs: "block", md: "grid" },
          columnGap: 6,
          // A video gets about half the width (more on wide screens) so faces and gestures
          // are visible; audio needs only a slim column.
          gridTemplateColumns: video
            ? { md: "minmax(0, 1fr) minmax(0, 1fr)", lg: "minmax(0, 7fr) minmax(0, 6fr)" }
            : "minmax(0, 20rem) minmax(0, 1fr)",
          alignItems: "start",
        }}
      >
        <Box
          component="aside"
          aria-label="Recording"
          sx={{ display: { xs: "contents", md: "block" }, alignSelf: "stretch" }}
        >
          <Box
            ref={measurePin}
            sx={{
              position: { xs: pinned ? "sticky" : "static", md: "sticky" },
              top: { xs: 0, md: 24 },
              zIndex: 2,
              mx: { xs: -2, sm: -3, md: 0 },
            }}
          >
            <Player
              interview={interview.data}
              segments={lines}
              startMs={startMs}
              ref={player}
              onTime={(ms) => {
                const seq = lineAt(ms)?.seq;
                setPlaying((prev) =>
                  prev && seq !== undefined && prev.seq === seq ? prev : { seq, ms },
                );
              }}
              failed={mediaFailed}
              onFailed={() => {
                setMediaFailed(true);
              }}
              onRetry={async () => {
                // A fresh signed media link comes with the interview.
                await interview.refetch();
                setMediaFailed(false);
              }}
            />
          </Box>
          <CopyTimeLink ms={linkMs} />
          <Box sx={{ mt: { xs: 3, md: 4 }, mb: { xs: 4, md: 0 } }}>
            <AboutRecording interview={interview.data} />
          </Box>
        </Box>
        <Box component="section" aria-labelledby="transcript" sx={{ minWidth: 0 }}>
          <Typography
            variant="overline"
            component="h2"
            id="transcript"
            sx={{ display: "block", borderBottom: 1, borderColor: "divider", pb: 0.5 }}
          >
            Transcript
          </Typography>
          {interview.isError ? (
            <Alert
              severity="warning"
              sx={{ mt: 2 }}
              action={
                <Button
                  color="inherit"
                  size="small"
                  onClick={() => {
                    void interview.refetch();
                  }}
                >
                  Try again
                </Button>
              }
            >
              The recording link couldn&apos;t be refreshed. The transcript below is still here.
            </Alert>
          ) : null}
          {segments.isError && segments.data === undefined ? (
            <Alert severity="error" sx={{ mt: 2 }}>
              The transcript couldn&apos;t be loaded.
            </Alert>
          ) : segments.data === undefined ? (
            <Skeleton variant="rectangular" height={240} sx={{ mt: 2 }} />
          ) : (
            <Transcript
              segments={segments.data.items}
              translation={interview.data.translation_status}
              onSeek={goToLine}
              canPlay={media !== null}
              highlightMs={t}
              playing={playing === null ? null : { seq: playing.seq }}
              stickyTop={pinned ? pinHeight : 0}
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
  segments,
  startMs,
  ref,
  onTime,
  failed,
  onFailed,
  onRetry,
}: {
  interview: InterviewDetail;
  segments: Segment[];
  startMs: number | undefined;
  ref: React.Ref<HTMLMediaElement>;
  onTime: (ms: number) => void;
  failed: boolean;
  onFailed: () => void;
  onRetry: () => Promise<void>;
}) {
  const media = interview.media;
  const video = media?.content_type.startsWith("video/") ?? false;
  const language = interview.primary_language?.code;
  // Where playback last was, so a retry picks up there.
  const lastMs = useRef(startMs);
  const [resumeMs, setResumeMs] = useState<number | undefined>(undefined);
  // Bumped on each retry so the media element starts over, even with the same link.
  const [attempt, setAttempt] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const captions = useMemo(
    () => (video ? captionTracks(segments, language) : []),
    [video, segments, language],
  );
  if (!media) {
    return (
      <Alert severity="info">
        {interview.status === "processing"
          ? "The recording is still being prepared for playback."
          : "The recording isn't available to play."}
      </Alert>
    );
  }
  // A media fragment (#t=seconds) makes the browser start there, with no effect to run.
  const from = resumeMs ?? startMs;
  const src = from === undefined ? media.url : `${media.url}#t=${String(from / 1000)}`;
  const report = (e: React.SyntheticEvent<HTMLMediaElement>) => {
    const ms = Math.round(e.currentTarget.currentTime * 1000);
    lastMs.current = ms;
    onTime(ms);
  };
  // Media links are signed and expire; the API issues a fresh one on each load.
  const props = {
    ref,
    src,
    controls: true,
    preload: "metadata",
    // While playing (loading the media also fires a time update, at 0), and after any seek,
    // so moving the playhead while paused moves the marker too.
    onTimeUpdate: (e: React.SyntheticEvent<HTMLMediaElement>) => {
      if (!e.currentTarget.paused) report(e);
    },
    onSeeked: report,
    onError: onFailed,
  } as const;
  return (
    <Box
      sx={{
        bgcolor: tokens.paper,
        p: { xs: 1, md: 1.5 },
        borderBottom: { xs: 1, md: 0 },
        border: { md: 1 },
        borderColor: { xs: "divider", md: "divider" },
        borderRadius: { md: 1 },
      }}
    >
      {failed ? (
        <Alert
          severity="error"
          sx={{ mb: 1 }}
          action={
            <Button
              color="inherit"
              size="small"
              loading={retrying}
              onClick={() => {
                setRetrying(true);
                setResumeMs(lastMs.current);
                void onRetry().finally(() => {
                  setRetrying(false);
                  setAttempt((n) => n + 1);
                });
              }}
            >
              Retry playback
            </Button>
          }
        >
          The recording couldn&apos;t be played.
        </Alert>
      ) : null}
      {video ? (
        <Box
          component="video"
          key={attempt}
          {...props}
          playsInline
          sx={{
            display: "block",
            width: "100%",
            // The file's own shape once it loads (a phone video may be upright), 16:9 until
            // then so the page doesn't jump.
            aspectRatio: "auto 16 / 9",
            // Never taller than most of the screen, so the transcript stays reachable.
            maxHeight: "70vh",
            bgcolor: "black",
          }}
        >
          {captions.map((track) => (
            <CaptionTrack key={track.label} {...track} />
          ))}
        </Box>
      ) : (
        <Box
          component="audio"
          key={attempt}
          {...props}
          sx={{ display: "block", width: "100%", height: 44 }}
        />
      )}
    </Box>
  );
}

type Caption = { label: string; srcLang: string; vtt: string; isDefault: boolean };

// Captions for a video, built from the transcript already on the page: the original (on by
// default) and the English, where any line has some. Audio needs none.
function captionTracks(segments: Segment[], language: string | undefined): Caption[] {
  if (segments.length === 0) return [];
  const original: Caption = {
    label: "Original (machine transcript)",
    srcLang: language ?? segments[0]?.language ?? "und",
    vtt: toVtt(segments.map((s) => ({ ...s, text: s.original_text }))),
    isDefault: true,
  };
  if (segments.every((s) => s.english_text === null)) return [original];
  const english = segments.flatMap((s) => {
    const text = englishText(s);
    return text === null ? [] : [{ ...s, text }];
  });
  return [
    original,
    {
      label: "English (machine translation)",
      srcLang: "en",
      vtt: toVtt(english),
      isDefault: false,
    },
  ];
}

function CaptionTrack({ label, srcLang, vtt, isDefault }: Caption) {
  const ref = useRef<HTMLTrackElement>(null);
  // The file lives at a blob: URL (allowed by media-src), freed when the track goes.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const url = URL.createObjectURL(new Blob([vtt], { type: "text/vtt" }));
    el.src = url;
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [vtt]);
  return <track ref={ref} kind="captions" label={label} srcLang={srcLang} default={isDefault} />;
}

function CopyTimeLink({ ms }: { ms: number }) {
  const { pathname } = useLocation();
  const [note, setNote] = useState("");
  const copy = async () => {
    const url = new URL(`${pathname}?t=${String(ms)}`, window.location.origin);
    try {
      await navigator.clipboard.writeText(url.href);
      setNote(`Link to ${formatClock(ms)} copied`);
    } catch {
      setNote("The link couldn't be copied. Copy it from the address bar.");
    }
  };
  return (
    <Stack direction="row" sx={{ alignItems: "center", flexWrap: "wrap", columnGap: 1.5, mt: 1 }}>
      <Button
        size="small"
        onClick={() => {
          void copy();
        }}
      >
        Copy link to this time
      </Button>
      <Typography variant="body2" color="text.secondary" aria-live="polite">
        {note}
      </Typography>
    </Stack>
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
        sx={{ borderBottom: 1, borderColor: "divider", pb: 0.5 }}
      >
        About this interview
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

// Full names where there is room; at 320px all three must still fit.
const TAB_LABELS = {
  wide: { both: "Original + English", original: "Original", english: "English translation" },
  narrow: { both: "Both", original: "Original", english: "English" },
} as const;

const FIND_SCOPE = {
  both: "Searches the original and the English",
  original: "Searches the original text shown",
  english: "Searches the English text shown (the original where a line has none)",
} as const;

// Which halves of a line a view shows (as LinePair does).
const shows = (s: Segment, view: View) => ({
  original: view !== "english" || englishText(s) === null,
  english:
    view === "english" ? englishText(s) !== null : view === "both" && s.english_text !== null,
});

// The text a view shows for a line (the original where an English view has none).
const texts = (s: Segment, view: View): string[] =>
  view === "english"
    ? [englishText(s) ?? s.original_text]
    : view === "original" || s.english_text === null
      ? [s.original_text]
      : [s.original_text, s.english_text];

// The lines whose shown text contains the query.
const matchingSeqs = (segments: Segment[], query: string, view: View): number[] => {
  const re = finder(query);
  return segments.filter((s) => texts(s, view).some((x) => hasMatch(x, re))).map((s) => s.seq);
};

function Transcript({
  segments,
  translation,
  onSeek,
  canPlay,
  highlightMs,
  playing,
  stickyTop,
}: {
  segments: Segment[];
  translation: InterviewDetail["translation_status"];
  onSeek: (ms: number) => void;
  /** False when there's no recording: a line's time then only points at the line. */
  canPlay: boolean;
  highlightMs: number | undefined;
  /** The line playing, once the recording has played. */
  playing: { seq: number | undefined } | null;
  /** On phones, how far below the top of the screen the find bar pins (the audio player). */
  stickyTop: number;
}) {
  // Original and English together when there is a translation: reading them side by side is
  // the point of a bilingual archive.
  const [tab, setTab] = useState<View>(translation === "done" ? "both" : "original");
  const [query, setQuery] = useState("");
  // Which of the matching lines is the current one.
  const [current, setCurrent] = useState(0);
  const wide = useMediaQuery(theme.breakpoints.up("sm"));
  const labels = TAB_LABELS[wide ? "wide" : "narrow"];
  const scrolled = useRef(false);
  const lineRefs = useRef(new Map<number, HTMLElement>());
  const lastPlaying = useRef<number | null>(null);
  const matches = useMemo(() => matchingSeqs(segments, query, tab), [segments, query, tab]);
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
  const someEnglish = segments.some((s) => s.english_text !== null);
  // With no English at all, the English view explains why rather than repeating the original.
  const englishNote =
    tab === "english" && !segments.some((s) => englishText(s) !== null)
      ? translationMissing[translation]
      : null;
  // English for some lines while the rest is still coming, or failed.
  const partialEnglish =
    tab !== "original" && someEnglish && (translation === "pending" || translation === "failed");
  const corrected = (s: Segment) => {
    const shown = shows(s, tab);
    return (shown.original && s.original_edited) || (shown.english && s.english_edited);
  };
  const anyCorrected = segments.some(corrected);

  const re = finder(query);
  const currentSeq = matches[Math.min(current, matches.length - 1)];
  // Scrolling happens in the handlers, since every line is already on the page. The find bar
  // is pinned, so bringing a line to the middle never moves the field out of view.
  const goTo = (seqs: number[], index: number) => {
    const wrapped = seqs.length ? (index + seqs.length) % seqs.length : 0;
    setCurrent(wrapped);
    const seq = seqs[wrapped];
    if (seq !== undefined) lineRefs.current.get(seq)?.scrollIntoView({ block: "center" });
  };

  // "You are here": the playing line once the recording plays, else the line opened at.
  const hereSeq = playing
    ? playing.seq
    : highlightMs === undefined
      ? undefined
      : segments.find((s) => highlightMs >= s.start_ms && highlightMs < s.end_ms)?.seq;
  // Follow playback only while the reader is following it: if the line that was playing is
  // on screen, keep the new one in view; if they scrolled away to read, leave them there.
  const followPlayback = (seq: number, el: HTMLElement) => {
    if (playing === null || lastPlaying.current === seq) return;
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
  const views: View[] = [
    ...(translation === "done" || someEnglish ? (["both"] as const) : []),
    "original",
    "english",
  ];

  return (
    <>
      <Tabs
        value={tab}
        onChange={(_, value: View) => {
          setTab(value);
          goTo(matchingSeqs(segments, query, value), 0);
        }}
        aria-label="Transcript language"
        variant="scrollable"
        scrollButtons="auto"
        allowScrollButtonsMobile
        sx={{ mb: 2, borderBottom: 1, borderColor: "divider" }}
      >
        {views.map((view) => (
          <Tab
            key={view}
            value={view}
            label={labels[view]}
            id={`transcript-tab-${view}`}
            aria-controls="transcript-panel"
          />
        ))}
      </Tabs>
      <div role="tabpanel" id="transcript-panel" aria-labelledby={`transcript-tab-${tab}`}>
        {englishNote ? (
          <Typography color="text.secondary">{englishNote}</Typography>
        ) : (
          <>
            {/* There's no manual review step, so every transcript carries this note. */}
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2, maxWidth: "65ch" }}>
              {partialEnglish ? "English is available for some lines only. " : null}
              {tab === "original" ? "Transcribed" : "Transcribed and translated"} by machine, so it
              may contain errors.
              {anyCorrected
                ? " Lines marked “Corrected” were fixed by the archive team."
                : null}{" "}
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
                // Pinned on every screen, so typing never scrolls the field out of view.
                position: "sticky",
                top: { xs: stickyTop, md: 0 },
                zIndex: 1,
                bgcolor: "background.default",
              }}
            >
              <TextField
                size="small"
                label="Find in transcript"
                helperText={FIND_SCOPE[tab]}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  goTo(matchingSeqs(segments, e.target.value, tab), 0);
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
                  formHelperText: { sx: { mx: 0 } },
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
                const clock = formatClock(s.start_ms);
                return (
                  <Box
                    component="li"
                    key={s.seq}
                    ref={(el: HTMLElement | null) => {
                      if (el) lineRefs.current.set(s.seq, el);
                      else lineRefs.current.delete(s.seq);
                      if (here && playing === null) scrollToHighlight(el);
                      if (here && el) followPlayback(s.seq, el);
                    }}
                    aria-current={here ? "true" : undefined}
                    sx={{
                      display: "grid",
                      gridTemplateColumns: "4.25rem minmax(0, 1fr)",
                      columnGap: { xs: 1.5, sm: 2 },
                      py: 1.5,
                      px: 1,
                      mx: -1,
                      bgcolor: here ? tokens.hereTint : undefined,
                      borderBottom: 1,
                      borderColor: "divider",
                      outline: isCurrent ? `2px solid ${tokens.plate}` : undefined,
                      outlineOffset: -2,
                      // Clears the pinned find bar (and on phones the pinned player).
                      scrollMarginTop: { xs: stickyTop + 140, md: 110 },
                      // Lets the browser skip laying out lines that are off screen.
                      contentVisibility: "auto",
                      containIntrinsicSize: "auto 4rem",
                    }}
                  >
                    <ButtonBase
                      onClick={() => {
                        onSeek(s.start_ms);
                      }}
                      aria-label={canPlay ? `Play from ${clock}` : `Select the line at ${clock}`}
                      sx={{
                        alignSelf: "start",
                        justifySelf: "start",
                        mt: "3px",
                        px: 0.75,
                        py: 0.25,
                        borderRadius: 1,
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
                      {clock}
                    </ButtonBase>
                    <Box sx={{ minWidth: 0 }}>
                      <LinePair
                        original={s.original_text}
                        english={s.english_text}
                        lang={s.language}
                        show={tab}
                        renderText={mark}
                        originalNotes={s.original_edited ? ["Corrected"] : []}
                        englishNotes={s.english_edited ? ["Corrected"] : []}
                      />
                    </Box>
                  </Box>
                );
              })}
            </Box>
          </>
        )}
      </div>
    </>
  );
}
