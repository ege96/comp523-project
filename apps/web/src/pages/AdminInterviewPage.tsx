import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Collapse from "@mui/material/Collapse";
import Container from "@mui/material/Container";
import LinearProgress from "@mui/material/LinearProgress";
import Paper from "@mui/material/Paper";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";

import { adminQueries, PROCESSING_POLL_MS, useUpdateInterview } from "../admin/api";
import { DetailsDialog } from "../admin/DetailsDialog";
import { PublishButton } from "../admin/PublishButton";
import { languageMismatch, retryableJobs } from "../admin/rerun";
import { RerunActions, RetryButton } from "../admin/RerunActions";
import { StagePill } from "../admin/StagePill";
import { TranscriptEditor } from "../admin/TranscriptEditor";
import { TRANSLATION_LABELS } from "../admin/status";
import { formatAdded, processingSteps, queueOf, type Queue, type Step } from "../admin/workflow";
import { ApiError, interviewQueries } from "../api/client";
import type { InterviewDetail, Job } from "../api/schemas";
import { useAuth } from "../auth/useAuth";
import { AlertIcon, ArrowBackIcon, CheckIcon } from "../components/icons";
import { ButtonLink, TextLink } from "../components/links";
import { formatClock, formatRecordedOn } from "../format";
import { tokens } from "../theme";

const route = getRouteApi("/admin/interviews/$interviewId");

/**
 * One recording as an admin works on it: what to do next, how processing is going, its
 * details, who can see it, and its transcript to check.
 */
export function AdminInterviewPage() {
  const { interviewId } = route.useParams();
  const { viewer } = useAuth();
  // Jobs can run while the status stays done: a re-index after a search model change, or
  // the search update after an edit. Keep watching until they end, since a failure changes
  // the status.
  const jobs = useQuery({
    ...adminQueries.jobs(viewer, interviewId),
    enabled: viewer.ready,
  });
  const busy = anyActive(jobs.data?.items);
  const { data, error } = useQuery({
    ...interviewQueries.detail(viewer, interviewId),
    enabled: viewer.ready,
    refetchInterval: (q) =>
      q.state.data?.status === "processing" || busy ? PROCESSING_POLL_MS : false,
  });

  return (
    <Container sx={{ py: { xs: 3, md: 5 } }}>
      <Stack spacing={3}>
        <TextLink
          to="/admin"
          variant="body2"
          underline="hover"
          sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, alignSelf: "flex-start" }}
        >
          <ArrowBackIcon fontSize="small" aria-hidden /> All interviews
        </TextLink>
        {/* A failed refresh keeps showing what was loaded; the admin may be mid-edit. */}
        {data ? (
          <Workspace interview={data} />
        ) : error ? (
          <Alert severity="error">
            {error instanceof ApiError && error.status === 404
              ? "This interview doesn't exist."
              : "The interview couldn't be loaded. Please try again."}
          </Alert>
        ) : (
          <Skeleton variant="rounded" height={320} />
        )}
      </Stack>
    </Container>
  );
}

function Workspace({ interview }: { interview: InterviewDetail }) {
  const { viewer } = useAuth();
  const jobs = useQuery({
    ...adminQueries.jobs(viewer, interview.id),
    enabled: viewer.ready,
    refetchInterval: (q) =>
      interview.status === "processing" || anyActive(q.state.data?.items)
        ? PROCESSING_POLL_MS
        : false,
  });
  const queue = queueOf(interview);
  return (
    <>
      <Stack spacing={1.5}>
        <Typography variant="h1" sx={{ overflowWrap: "anywhere", textWrap: "balance" }}>
          {interview.title}
        </Typography>
        <Stack
          direction="row"
          spacing={1.5}
          useFlexGap
          sx={{ alignItems: "center", flexWrap: "wrap" }}
        >
          <StagePill queue={queue} />
          <Typography variant="body2" color="text.secondary">
            {interview.visibility === "public"
              ? "Public: visitors can find it"
              : "Private: only admins can see it"}
          </Typography>
          {/* The viewer opens with the admin's session, so it also shows admin-only notes. */}
          <Typography variant="body2" color="text.secondary">
            <TextLink to="/interviews/$interviewId" params={{ interviewId: interview.id }}>
              Preview the public page
            </TextLink>{" "}
            (admin-only notes show too)
          </Typography>
        </Stack>
      </Stack>

      <NextStep interview={interview} queue={queue} jobs={jobs.data?.items} />

      <Box
        sx={{
          display: "grid",
          gap: 3,
          gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "minmax(0, 7fr) minmax(0, 5fr)" },
          alignItems: "start",
        }}
      >
        {/* Where it stands (processing, then who can see it) on the left; facts on the right. */}
        <Stack spacing={3}>
          <Processing interview={interview} queue={queue} jobs={jobs} />
          <WhoCanSee interview={interview} queue={queue} jobs={jobs.data?.items} />
        </Stack>
        <Details interview={interview} />
      </Box>

      <Box id="transcript" sx={{ scrollMarginTop: 16 }}>
        <TranscriptEditor interview={interview} />
      </Box>
    </>
  );
}

/** A titled panel, as in the admin mockup. */
function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Paper component="section" sx={{ p: { xs: 2, sm: 3 } }}>
      <Stack spacing={2}>
        <Typography variant="h3" component="h2">
          {title}
        </Typography>
        {children}
      </Stack>
    </Paper>
  );
}

const ACCENT = {
  attention: "#b77a1a",
  processing: tokens.ruleStrong,
  ready: tokens.plate,
  published: "#4d7f52",
} as const satisfies Record<Queue, string>;

/** The one thing to do now, in a sentence, with its button. */
function anyActive(jobs: readonly Job[] | undefined): boolean {
  return jobs?.some((j) => j.state === "queued" || j.state === "running") ?? false;
}

/** A search update in the background, while the interview itself is finished. */
function SearchUpdating({ jobs }: { jobs: Job[] | undefined }) {
  const indexing = processingSteps(jobs ?? []).some(
    (s) => s.key === "index" && (s.job.state === "queued" || s.job.state === "running"),
  );
  return indexing ? (
    <Typography variant="body2" color="text.secondary" role="status">
      Search is being updated for this interview. Until that finishes, search may show older wording
      or miss it. Nothing to do.
    </Typography>
  ) : null;
}

function NextStep({
  interview,
  queue,
  jobs,
}: {
  interview: InterviewDetail;
  queue: Queue;
  jobs: Job[] | undefined;
}) {
  const retryable = [...retryableJobs(jobs ?? [])];
  const steps = processingSteps(jobs ?? []);
  const labelOf = (job: Job) => steps.find((s) => s.job === job)?.label ?? "this step";
  // The file itself couldn't be read: retrying rarely helps, a converted file usually does.
  const unreadable = retryable.some((job) => job.kind === "playback");
  const content: { heading: string; body: ReactNode; actions?: ReactNode } = (() => {
    switch (queue) {
      case "attention":
        return {
          heading: "Processing stopped",
          body: (
            <>
              <Typography>
                {interview.status_detail ?? "One of the processing steps didn't work."}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {unreadable
                  ? "The recording's file couldn't be read. Retrying sometimes works; if not, convert the file (for example to MP4 or MP3) and upload it as a new interview. "
                  : "Retrying often works. "}
                If it keeps stopping, the steps below have details to pass on to whoever looks after
                the archive.
              </Typography>
            </>
          ),
          actions:
            retryable.length === 0 ? undefined : (
              <>
                {retryable.map((job) => (
                  <RetryButton
                    key={job.kind}
                    interview={interview}
                    job={job}
                    variant="contained"
                    label={
                      retryable.length > 1
                        ? `Retry processing: ${labelOf(job)}`
                        : "Retry processing"
                    }
                  />
                ))}
                {unreadable ? (
                  <ButtonLink to="/admin" hash="add-interview" variant="outlined">
                    Upload a converted file
                  </ButtonLink>
                ) : null}
              </>
            ),
        };
      case "processing":
        return {
          heading: "Being processed",
          body: (
            <>
              <Typography>
                {interview.status_detail ?? "The transcript and English are being made."}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {interview.visibility === "public"
                  ? "It's already published: visitors see “transcript in progress” until it's done. "
                  : null}
                Long recordings take a while. You can leave this page; it carries on without you.
                Meanwhile, check the details are right.
              </Typography>
              <LinearProgress aria-label="Processing" sx={{ maxWidth: 320 }} />
            </>
          ),
        };
      case "ready":
        return {
          heading: "Finished, not published",
          body: (
            <>
              <Typography>
                The transcript is done. Visitors can&apos;t see this interview until it&apos;s
                published.
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {interview.translation_status === "failed"
                  ? "The English translation didn't work, so visitors would see only the original words. "
                  : null}
                You can correct the transcript at any time, whether it&apos;s published or not.
              </Typography>
              <SearchUpdating jobs={jobs} />
            </>
          ),
          actions: (
            <>
              <PublishButton interview={interview} jobs={jobs} />
              <Button href="#transcript" variant="outlined">
                Correct the transcript
              </Button>
            </>
          ),
        };
      case "published":
        return {
          heading: "Published",
          body: (
            <>
              <Typography>
                Visitors can find it in search, play it and read the transcript. Corrections you
                make below show to them too.
              </Typography>
              <SearchUpdating jobs={jobs} />
            </>
          ),
          actions: (
            <>
              <Button href="#transcript" variant="outlined">
                Correct the transcript
              </Button>
              <PublishButton interview={interview} jobs={jobs} />
            </>
          ),
        };
    }
  })();
  return (
    <Paper
      component="section"
      aria-labelledby="next-step"
      sx={{ p: { xs: 2, sm: 3 }, borderLeft: `4px solid ${ACCENT[queue]}` }}
    >
      <Stack spacing={1.5}>
        <Typography variant="overline" color="text.secondary" component="p">
          Next step
        </Typography>
        <Typography id="next-step" variant="h2" sx={{ mt: "0 !important" }}>
          {content.heading}
        </Typography>
        <Stack spacing={1} sx={{ maxWidth: "70ch" }}>
          {content.body}
        </Stack>
        {content.actions ? (
          <Stack
            direction={{ xs: "column", sm: "row" }}
            spacing={1.5}
            sx={{ pt: 0.5, alignItems: { xs: "stretch", sm: "flex-start" } }}
          >
            {content.actions}
          </Stack>
        ) : null}
      </Stack>
    </Paper>
  );
}

const STATE_TEXT = {
  queued: "Waiting",
  running: "In progress",
  done: "Done",
  failed: "Didn't work",
} as const satisfies Record<Job["state"], string>;

function Processing({
  interview,
  queue,
  jobs,
}: {
  interview: InterviewDetail;
  queue: Queue;
  jobs: { data?: { items: Job[] }; isPending: boolean; isError: boolean };
}) {
  const mismatch = languageMismatch(interview);
  const [fixing, setFixing] = useState(mismatch !== null);
  const steps = processingSteps(jobs.data?.items ?? []);
  const retryable = retryableJobs(jobs.data?.items ?? []);
  // Proposal: once everything has finished, the steps fold into one line; anything waiting,
  // running or failed keeps them open.
  const allDone =
    interview.status === "done" && steps.length > 0 && steps.every((s) => s.job.state === "done");
  const [showSteps, setShowSteps] = useState(false);
  const toggleSteps = (
    <Button
      size="small"
      aria-expanded={showSteps}
      aria-controls="processing-steps"
      onClick={() => {
        setShowSteps((open) => !open);
      }}
      sx={{ paddingInline: 1, flexShrink: 0 }}
    >
      {showSteps ? "Hide steps" : "Show steps"}
    </Button>
  );
  return (
    <Panel title="Processing">
      {jobs.isError ? (
        <Alert severity="error">The processing steps couldn&apos;t be loaded.</Alert>
      ) : jobs.isPending ? (
        <Skeleton variant="rounded" height={160} />
      ) : steps.length === 0 ? (
        <Typography color="text.secondary">Nothing has started yet.</Typography>
      ) : (
        <>
          {allDone ? (
            <Box
              sx={{
                display: "grid",
                gridTemplateColumns: "28px minmax(0, 1fr) auto",
                columnGap: 1.5,
                alignItems: "center",
              }}
            >
              <StepMark state="done" />
              <Typography>All steps finished</Typography>
              {toggleSteps}
            </Box>
          ) : null}
          {!allDone || showSteps ? (
            <Box
              component="ol"
              id="processing-steps"
              aria-label="Processing steps"
              sx={{ listStyle: "none", m: 0, p: 0 }}
            >
              {steps.map((step) => (
                <StepRow
                  key={step.key}
                  step={step}
                  interview={interview}
                  // On a stopped recording the retry is the next step's button, up above.
                  retry={queue !== "attention" && retryable.has(step.job)}
                />
              ))}
            </Box>
          ) : null}
        </>
      )}
      {interview.translation_status === "not_needed" ? (
        <Typography variant="body2" color="text.secondary">
          No English translation needed: the recording is in English.
        </Typography>
      ) : null}

      <Box sx={{ borderTop: 1, borderColor: "divider", pt: 2 }}>
        <Button
          variant="text"
          size="small"
          aria-expanded={fixing}
          aria-controls="fix-a-problem"
          onClick={() => {
            setFixing((open) => !open);
          }}
          sx={{ paddingInline: 1, ml: -1 }}
        >
          {fixing ? "Hide" : "Something wrong with the transcript or English?"}
        </Button>
        <Collapse in={fixing} id="fix-a-problem">
          <Stack spacing={1.5} sx={{ pt: 1.5 }}>
            <Typography variant="body2" color="text.secondary">
              For a few wrong words, correct them in the transcript below. For bigger problems:
            </Typography>
            <RerunActions interview={interview} />
          </Stack>
        </Collapse>
      </Box>
    </Panel>
  );
}

function StepRow({
  step,
  interview,
  retry,
}: {
  step: Step;
  interview: InterviewDetail;
  retry: boolean;
}) {
  const { job } = step;
  const failed = job.state === "failed";
  return (
    <Box
      component="li"
      sx={{
        display: "grid",
        gridTemplateColumns: "28px minmax(0, 1fr)",
        columnGap: 1.5,
        py: 1.25,
        borderBottom: 1,
        borderColor: "divider",
        "&:last-of-type": { borderBottom: 0 },
      }}
    >
      <StepMark state={job.state} />
      <Stack spacing={0.75} sx={{ minWidth: 0 }}>
        <Stack
          direction="row"
          spacing={1}
          sx={{ justifyContent: "space-between", alignItems: "baseline" }}
        >
          <Typography sx={{ fontWeight: failed ? 600 : 400 }}>{step.label}</Typography>
          <Typography
            variant="body2"
            sx={{ color: failed ? "error.main" : "text.secondary", flexShrink: 0 }}
          >
            {STATE_TEXT[job.state]}
          </Typography>
        </Stack>
        {failed ? (
          <>
            <Typography variant="body2" color="text.secondary">
              Tried {job.attempts === 1 ? "once" : `${String(job.attempts)} times`}.
            </Typography>
            {retry ? (
              <RetryButton interview={interview} job={job} label="Retry processing" />
            ) : null}
            {job.last_error ? <TechnicalDetail text={job.last_error} /> : null}
          </>
        ) : null}
      </Stack>
    </Box>
  );
}

function StepMark({ state }: { state: Job["state"] }) {
  const ring = {
    width: 24,
    height: 24,
    borderRadius: "50%",
    display: "grid",
    placeItems: "center",
    mt: "2px",
  } as const;
  switch (state) {
    case "done":
      return (
        <Box sx={{ ...ring, bgcolor: "#e2ede2", color: "#2f5a33" }}>
          <CheckIcon sx={{ fontSize: 16 }} aria-hidden />
        </Box>
      );
    case "failed":
      return (
        <Box sx={{ ...ring, bgcolor: "error.main", color: "#fff" }}>
          <AlertIcon sx={{ fontSize: 16 }} aria-hidden />
        </Box>
      );
    case "running":
      return (
        <Box sx={{ ...ring }}>
          <CircularProgress size={18} thickness={5} aria-hidden />
        </Box>
      );
    case "queued":
      return <Box sx={{ ...ring, border: 2, borderColor: tokens.rule }} />;
  }
}

/**
 * A failure's raw text (often a provider's JSON), folded away: the plain message is in the next
 * step above. Shown on request, for passing on to whoever looks after the archive.
 */
function TechnicalDetail({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return open ? (
    <Typography
      component="pre"
      variant="caption"
      sx={{
        m: 0,
        p: 1.5,
        bgcolor: "background.default",
        borderRadius: 1,
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
        fontFamily: "monospace",
      }}
    >
      {text}
    </Typography>
  ) : (
    <Button
      size="small"
      onClick={() => {
        setOpen(true);
      }}
      sx={{ alignSelf: "flex-start", paddingInline: 1, ml: -1 }}
    >
      Show technical details
    </Button>
  );
}

function languageFact(interview: InterviewDetail): string {
  const name = interview.primary_language?.name;
  if (!name) return "Not detected yet";
  return interview.language_confirmed ? `${name} (checked)` : `${name} (detected)`;
}

function Details({ interview }: { interview: InterviewDetail }) {
  const [editing, setEditing] = useState(false);
  const facts: [string, string][] = [
    ["Interviewee", interview.interviewee ?? "Unknown"],
    ["Original language", languageFact(interview)],
    ["Recorded", formatRecordedOn(interview) ?? "Unknown"],
    [
      "Length",
      interview.duration_ms === null ? "Not known yet" : formatClock(interview.duration_ms),
    ],
    ["English translation", TRANSLATION_LABELS[interview.translation_status]],
    ["Added", formatAdded(interview.created_at)],
  ];
  const open = () => {
    setEditing(true);
  };
  return (
    <Panel title="Details">
      <LanguageCheck interview={interview} onChange={open} />
      <Box
        component="dl"
        sx={{
          m: 0,
          display: "grid",
          gridTemplateColumns: "auto minmax(0, 1fr)",
          columnGap: 2,
          rowGap: 1,
        }}
      >
        {facts.map(([label, value]) => (
          <Box key={label} sx={{ display: "contents" }}>
            <Typography component="dt" variant="body2" color="text.secondary">
              {label}
            </Typography>
            <Typography component="dd" variant="body2" sx={{ m: 0, overflowWrap: "anywhere" }}>
              {value}
            </Typography>
          </Box>
        ))}
      </Box>
      <Button variant="outlined" onClick={open} sx={{ alignSelf: "flex-start" }}>
        Edit details
      </Button>
      {/* Mounted only while open, so the form starts from the latest details each time. */}
      {editing ? (
        <DetailsDialog
          interview={interview}
          open
          onClose={() => {
            setEditing(false);
          }}
        />
      ) : null}
    </Panel>
  );
}

/**
 * D-004: the language is detected from the audio and an admin confirms or corrects it. Asked
 * as a yes/no question, because Nepal Bhasa is often detected as Nepali.
 */
function LanguageCheck({
  interview,
  onChange,
}: {
  interview: InterviewDetail;
  onChange: () => void;
}) {
  const update = useUpdateInterview(interview.id);
  const detected = interview.language_detected;
  if (interview.language_confirmed || !detected || !interview.primary_language) return null;
  return (
    <Box
      sx={{ p: 2, borderRadius: 1, bgcolor: tokens.hereTint, border: 1, borderColor: tokens.rule }}
    >
      <Stack spacing={1.25}>
        <Typography sx={{ fontWeight: 600 }}>
          Is {interview.primary_language.name} the right language?
        </Typography>
        <Typography variant="body2" color="text.secondary">
          It was worked out from the audio. Nepal Bhasa is sometimes taken for Nepali.
        </Typography>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
          <Button
            variant="contained"
            size="small"
            disabled={update.isPending}
            onClick={() => {
              update.mutate({ language: detected });
            }}
          >
            Yes, it&apos;s right
          </Button>
          <Button variant="outlined" size="small" onClick={onChange}>
            No, change it
          </Button>
        </Stack>
        {update.isError ? (
          <Typography variant="body2" color="error" role="alert">
            That couldn&apos;t be saved. Try again.
          </Typography>
        ) : null}
      </Stack>
    </Box>
  );
}

function WhoCanSee({
  interview,
  queue,
  jobs,
}: {
  interview: InterviewDetail;
  queue: Queue;
  jobs: Job[] | undefined;
}) {
  // Ready and published recordings have Publish / Unpublish in the next step already.
  const showButton = queue === "attention" || queue === "processing";
  return (
    <Panel title="Who can see it">
      <Typography variant="body2">
        {interview.visibility === "private"
          ? "Private. Only admins can see it. Visitors can't find it or play it."
          : queue === "published"
            ? "Public. Anyone can find it in search, play it and read the transcript, labelled as machine-made with your corrections marked."
            : queue === "processing"
              ? "Public. Anyone on the web can open it; visitors see the transcript marked as in progress until processing finishes."
              : "Public. Anyone on the web can open it; visitors see it marked “Transcript unavailable” until processing works."}
      </Typography>
      {showButton ? (
        <>
          {interview.visibility === "private" ? (
            <Typography variant="body2" color="text.secondary">
              {queue === "attention"
                ? "You can still publish it. Visitors then see it marked “Transcript unavailable”."
                : "You can publish it before processing finishes. Visitors then see the transcript marked as in progress."}
            </Typography>
          ) : null}
          <Box sx={{ alignSelf: "flex-start" }}>
            {/* When processing stopped, Retry processing above is the main action. */}
            <PublishButton interview={interview} jobs={jobs} quiet={queue === "attention"} />
          </Box>
        </>
      ) : null}
    </Panel>
  );
}
