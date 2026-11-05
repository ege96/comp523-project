import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Container from "@mui/material/Container";
import Paper from "@mui/material/Paper";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useState } from "react";

import { adminQueries, PROCESSING_POLL_MS } from "../admin/api";
import { DetailsDialog } from "../admin/DetailsDialog";
import { retryableJobs } from "../admin/rerun";
import { RerunActions, RetryButton } from "../admin/RerunActions";
import { TranscriptEditor } from "../admin/TranscriptEditor";
import { jobLabel, STATUS_COLORS, STATUS_LABELS, TRANSLATION_LABELS } from "../admin/status";
import { VisibilitySwitch } from "../admin/VisibilitySwitch";
import { ApiError, interviewQueries } from "../api/client";
import type { InterviewDetail } from "../api/schemas";
import { useAuth } from "../auth/useAuth";
import { TextLink } from "../components/links";
import { formatClock, formatRecordedOn } from "../format";

const route = getRouteApi("/admin/interviews/$interviewId");

/** One interview as an admin sees it: status, every processing step, and visibility. */
export function AdminInterviewPage() {
  const { interviewId } = route.useParams();
  const { viewer } = useAuth();
  const { data, error, isPending } = useQuery({
    ...interviewQueries.detail(viewer, interviewId),
    enabled: viewer.ready,
    refetchInterval: (q) => (q.state.data?.status === "processing" ? PROCESSING_POLL_MS : false),
  });

  return (
    <Container sx={{ py: 6 }}>
      <Stack spacing={3}>
        <TextLink to="/admin" variant="body2">
          Back to upload &amp; review
        </TextLink>
        {error ? (
          <Alert severity="error">
            {error instanceof ApiError && error.status === 404
              ? "This interview doesn't exist."
              : "The interview couldn't be loaded. Please try again."}
          </Alert>
        ) : isPending ? (
          <Skeleton variant="rounded" height={320} />
        ) : (
          <>
            <Summary interview={data} />
            <ProcessingSteps interview={data} />
            <TranscriptEditor interview={data} />
          </>
        )}
      </Stack>
    </Container>
  );
}

function languageFact(interview: InterviewDetail): string {
  const name = interview.primary_language?.name;
  if (!name) return "Not detected yet";
  return interview.language_confirmed ? `${name} (set by an admin)` : `${name} (detected)`;
}

function Summary({ interview }: { interview: InterviewDetail }) {
  const [editing, setEditing] = useState(false);
  const facts: [string, string][] = [
    ["Interviewee", interview.interviewee ?? "Unknown"],
    ["Original language", languageFact(interview)],
    ["Recorded", formatRecordedOn(interview) ?? "Unknown"],
    [
      "Duration",
      interview.duration_ms === null ? "Not known yet" : formatClock(interview.duration_ms),
    ],
    ["English translation", TRANSLATION_LABELS[interview.translation_status]],
    ["Added", new Date(interview.created_at).toLocaleString("en-GB")],
  ];
  return (
    <Paper sx={{ p: { xs: 2, sm: 3 } }}>
      <Stack spacing={2}>
        <Stack
          direction={{ xs: "column", sm: "row" }}
          spacing={2}
          sx={{ justifyContent: "space-between", alignItems: { sm: "flex-start" } }}
        >
          <Typography variant="h1" sx={{ overflowWrap: "anywhere" }}>
            {interview.title}
          </Typography>
          <Stack direction="row" spacing={2} sx={{ alignItems: "center", flexShrink: 0 }}>
            <Button
              variant="outlined"
              size="small"
              onClick={() => {
                setEditing(true);
              }}
            >
              Edit details
            </Button>
            <VisibilitySwitch interview={interview} />
          </Stack>
        </Stack>
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ flexWrap: "wrap", alignItems: "center" }}
        >
          <Chip
            size="small"
            color={STATUS_COLORS[interview.status]}
            label={STATUS_LABELS[interview.status]}
          />
          {interview.status_detail ? (
            <Typography variant="body2" color="text.secondary">
              {interview.status_detail}
            </Typography>
          ) : null}
        </Stack>
        <Stack
          component="dl"
          sx={{
            m: 0,
            display: "grid",
            gridTemplateColumns: { xs: "1fr", sm: "repeat(3, minmax(0, 1fr))" },
            gap: 2,
          }}
        >
          {facts.map(([label, value]) => (
            <div key={label}>
              <Typography component="dt" variant="overline" color="text.secondary">
                {label}
              </Typography>
              <Typography component="dd" sx={{ m: 0 }}>
                {value}
              </Typography>
            </div>
          ))}
        </Stack>
        <Typography variant="body2" color="text.secondary">
          {interview.visibility === "public"
            ? "Visitors can find and play this interview. They see the transcript labelled as machine-generated, with your corrections marked."
            : "Only admins can see this interview."}{" "}
          <TextLink to="/interviews/$interviewId" params={{ interviewId: interview.id }}>
            Open in the archive viewer
          </TextLink>
        </Typography>
      </Stack>
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
    </Paper>
  );
}

function ProcessingSteps({ interview }: { interview: InterviewDetail }) {
  const { viewer } = useAuth();
  const { data, isPending, isError } = useQuery({
    ...adminQueries.jobs(viewer, interview.id),
    enabled: viewer.ready,
    refetchInterval: interview.status === "processing" ? PROCESSING_POLL_MS : false,
  });
  const retryable = retryableJobs(data?.items ?? []);
  return (
    <Paper sx={{ p: { xs: 2, sm: 3 } }}>
      <Stack spacing={2}>
        <Typography variant="h2">Processing steps</Typography>
        <RerunActions interview={interview} />
        {isError ? (
          <Alert severity="error">The processing steps couldn&apos;t be loaded.</Alert>
        ) : isPending ? (
          <Skeleton variant="rounded" height={120} />
        ) : data.items.length === 0 ? (
          <Typography color="text.secondary">No steps have been queued yet.</Typography>
        ) : (
          <TableContainer>
            <Table size="small" aria-label="Processing steps">
              <TableHead>
                <TableRow>
                  <TableCell>Step</TableCell>
                  <TableCell>State</TableCell>
                  <TableCell>Attempts</TableCell>
                  <TableCell>Last error</TableCell>
                  <TableCell>Action</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {data.items.map((job, i) => (
                  <TableRow key={`${job.kind}-${String(i)}`}>
                    <TableCell>{jobLabel(job)}</TableCell>
                    <TableCell>{JOB_STATES[job.state]}</TableCell>
                    <TableCell>
                      {job.attempts} of {job.max_attempts}
                    </TableCell>
                    <TableCell sx={{ overflowWrap: "anywhere", maxWidth: 360 }}>
                      {job.last_error ?? "None"}
                    </TableCell>
                    <TableCell>
                      {retryable.has(job) ? <RetryButton interview={interview} job={job} /> : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Stack>
    </Paper>
  );
}

const JOB_STATES = {
  queued: "Waiting",
  running: "Running",
  done: "Done",
  failed: "Failed",
} as const;
