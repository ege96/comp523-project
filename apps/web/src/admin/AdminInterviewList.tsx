import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Pagination from "@mui/material/Pagination";
import Paper from "@mui/material/Paper";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import Typography from "@mui/material/Typography";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import type { InterviewSummary } from "../api/schemas";
import { useAuth } from "../auth/useAuth";
import { ArrowForwardIcon } from "../components/icons";
import { ButtonLink, TextLink } from "../components/links";
import { visuallyHidden } from "../components/visuallyHidden";
import { formatClock, formatRecordedOn } from "../format";
import { adminQueries } from "./api";
import { StagePill } from "./StagePill";
import {
  nextStep,
  QUEUE_EMPTY,
  QUEUE_FILTERS,
  QUEUE_LABELS,
  queueOf,
  QUEUES,
  type Queue,
} from "./workflow";

const PAGE_SIZE = 20;

/**
 * Every recording, Private included, sorted by what the admin does next. Each row says its
 * next step and has one button for it. Refreshes itself while anything shown is processing.
 */
export function AdminInterviewList({
  view,
  page,
  onChange,
}: {
  view: Queue | undefined;
  page: number;
  onChange: (next: { view: Queue | undefined; page: number }) => void;
}) {
  const { viewer } = useAuth();
  const { data, isPending, isError } = useQuery({
    ...adminQueries.interviews(viewer, {
      ...(view ? QUEUE_FILTERS[view] : {}),
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    enabled: viewer.ready,
    placeholderData: keepPreviousData,
  });
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <Paper component="section" aria-labelledby="queue-title">
      <Stack spacing={1.5} sx={{ px: { xs: 2, sm: 3 }, pt: { xs: 2, sm: 3 } }}>
        <Typography id="queue-title" variant="h2">
          All interviews
        </Typography>
        <Tabs
          value={view ?? "all"}
          onChange={(_e, value: Queue | "all") => {
            onChange({ view: value === "all" ? undefined : value, page: 1 });
          }}
          variant="scrollable"
          allowScrollButtonsMobile
          aria-label="Show interviews that are"
          sx={{
            borderBottom: 1,
            borderColor: "divider",
            mx: { xs: -2, sm: -3 },
            px: { sm: 1.5 },
            "& .MuiTab-root": { minWidth: 0, px: 1.5 },
          }}
        >
          <Tab value="all" label="All" />
          {QUEUES.map((q) => (
            <Tab key={q} value={q} label={<QueueTabLabel queue={q} />} />
          ))}
        </Tabs>
      </Stack>
      <Box sx={{ px: { xs: 2, sm: 3 }, pb: { xs: 2, sm: 3 } }}>
        {isError ? (
          <Alert severity="error" sx={{ mt: 2 }}>
            The interviews couldn&apos;t be loaded. Please try again.
          </Alert>
        ) : isPending ? (
          <Skeleton variant="rounded" height={320} sx={{ mt: 2 }} />
        ) : data.items.length === 0 ? (
          <Typography color="text.secondary" sx={{ py: 4 }}>
            {view ? QUEUE_EMPTY[view] : "No interviews yet. Add one to start."}
          </Typography>
        ) : (
          <Box component="ul" sx={{ listStyle: "none", m: 0, p: 0 }}>
            {data.items.map((interview) => (
              <QueueRow key={interview.id} interview={interview} />
            ))}
          </Box>
        )}
        {pages > 1 ? (
          <Pagination
            page={page}
            count={pages}
            sx={{ display: "flex", justifyContent: "center", pt: 2 }}
            onChange={(_e, next) => {
              onChange({ view, page: next });
            }}
          />
        ) : null}
      </Box>
    </Paper>
  );
}

/** A tab's name with how many recordings are in it, so the admin sees where work waits. */
function QueueTabLabel({ queue }: { queue: Queue }) {
  const { viewer } = useAuth();
  const { data } = useQuery({
    ...adminQueries.interviews(viewer, { ...QUEUE_FILTERS[queue], limit: 1 }),
    enabled: viewer.ready,
  });
  const count = data?.total;
  const urgent = queue === "attention" && count !== undefined && count > 0;
  return (
    <Stack direction="row" spacing={0.75} sx={{ alignItems: "center" }}>
      <span>{QUEUE_LABELS[queue]}</span>
      {count === undefined ? null : (
        <Box
          component="span"
          aria-hidden
          sx={{
            minWidth: 22,
            px: 0.75,
            borderRadius: 999,
            fontSize: "0.75rem",
            lineHeight: "20px",
            textAlign: "center",
            bgcolor: urgent ? "#fbe9c8" : "action.hover",
            color: urgent ? "#6e4300" : "text.secondary",
          }}
        >
          {count}
        </Box>
      )}
      {count === undefined ? null : (
        <Box component="span" sx={visuallyHidden}>
          ({count})
        </Box>
      )}
    </Stack>
  );
}

function QueueRow({ interview }: { interview: InterviewSummary }) {
  const queue = queueOf(interview);
  const step = nextStep(interview);
  const details = [
    interview.interviewee ?? "Interviewee unknown",
    interview.primary_language?.name ?? "Language not known yet",
    interview.duration_ms === null ? null : formatClock(interview.duration_ms),
    formatRecordedOn(interview),
    interview.visibility === "public" ? "Public" : "Private",
  ].filter(Boolean);
  const urgent = queue === "attention";
  return (
    <Box
      component="li"
      sx={{
        py: 2.25,
        borderBottom: 1,
        borderColor: "divider",
        "&:last-of-type": { borderBottom: 0 },
        display: "grid",
        gap: { xs: 1.25, sm: 2 },
        gridTemplateColumns: { xs: "minmax(0, 1fr)", sm: "minmax(0, 1fr) auto" },
        alignItems: "center",
      }}
    >
      <Stack spacing={0.5} sx={{ minWidth: 0, alignItems: "flex-start" }}>
        <TextLink
          to="/admin/interviews/$interviewId"
          params={{ interviewId: interview.id }}
          variant="subtitle1"
          underline="hover"
          color="inherit"
          // The button beside it goes to the same page; one stop per row for keyboards.
          tabIndex={-1}
          sx={{ overflowWrap: "anywhere" }}
        >
          {interview.title}
        </TextLink>
        <Typography variant="body2" color="text.secondary">
          {details.join(" · ")}
        </Typography>
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ alignItems: "center", flexWrap: "wrap", pt: 0.5 }}
        >
          <StagePill queue={queue} />
          <Typography variant="body2">{step.text}</Typography>
        </Stack>
      </Stack>
      <ButtonLink
        to="/admin/interviews/$interviewId"
        params={{ interviewId: interview.id }}
        variant={urgent ? "contained" : "outlined"}
        size="small"
        endIcon={<ArrowForwardIcon aria-hidden />}
        aria-label={`${step.action}: ${interview.title}`}
        sx={{ justifySelf: { xs: "start", sm: "end" }, whiteSpace: "nowrap" }}
      >
        {step.action}
      </ButtonLink>
    </Box>
  );
}
