import Alert from "@mui/material/Alert";
import Chip from "@mui/material/Chip";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
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
import { TextLink } from "../components/links";
import { formatRecordedOn } from "../format";
import { adminQueries, type Status } from "./api";
import { STATUS_COLORS, STATUS_LABELS } from "./status";
import { VisibilitySwitch } from "./VisibilitySwitch";

const PAGE_SIZE = 20;
const FILTERS = ["processing", "done", "failed"] as const satisfies Status[];

/**
 * Every interview, Private included, with its processing status and a publish toggle.
 * Refreshes itself while anything on the page is still processing.
 */
export function AdminInterviewList({
  status,
  page,
  onChange,
}: {
  status: Status | undefined;
  page: number;
  onChange: (next: { status: Status | undefined; page: number }) => void;
}) {
  const { viewer } = useAuth();
  const { data, isPending, isError } = useQuery({
    ...adminQueries.interviews(viewer, {
      status,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    enabled: viewer.ready,
    placeholderData: keepPreviousData,
  });
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <Paper sx={{ p: { xs: 2, sm: 3 } }}>
      <Stack spacing={2}>
        <Typography variant="h2">Interviews</Typography>
        <Tabs
          value={status ?? "all"}
          onChange={(_e, value: Status | "all") => {
            onChange({ status: value === "all" ? undefined : value, page: 1 });
          }}
          variant="scrollable"
          allowScrollButtonsMobile
          aria-label="Filter by status"
        >
          <Tab value="all" label="All" />
          {FILTERS.map((s) => (
            <Tab key={s} value={s} label={STATUS_LABELS[s]} />
          ))}
        </Tabs>
        {isError ? (
          <Alert severity="error">Interviews couldn&apos;t be loaded. Please try again.</Alert>
        ) : isPending ? (
          <Skeleton variant="rounded" height={320} />
        ) : data.items.length === 0 ? (
          <Typography color="text.secondary">
            {status
              ? `No interviews are ${STATUS_LABELS[status].toLowerCase()}.`
              : "No interviews yet. Upload one to start."}
          </Typography>
        ) : (
          <List disablePadding>
            {data.items.map((interview, i) => (
              <ListItem
                key={interview.id}
                divider={i < data.items.length - 1}
                sx={{ px: 0, py: 2 }}
              >
                <AdminRow interview={interview} />
              </ListItem>
            ))}
          </List>
        )}
        {pages > 1 ? (
          <Pagination
            page={page}
            count={pages}
            sx={{ alignSelf: "center" }}
            onChange={(_e, next) => {
              onChange({ status, page: next });
            }}
          />
        ) : null}
      </Stack>
    </Paper>
  );
}

function AdminRow({ interview }: { interview: InterviewSummary }) {
  const details = [
    interview.interviewee ?? "Interviewee unknown",
    interview.primary_language?.name ?? "Language not detected yet",
    formatRecordedOn(interview) ?? "Date unknown",
  ];
  return (
    <Stack
      direction={{ xs: "column", sm: "row" }}
      spacing={{ xs: 1, sm: 2 }}
      sx={{ width: 1, alignItems: { sm: "center" } }}
    >
      <Stack spacing={0.5} sx={{ flex: 1, minWidth: 0 }}>
        <TextLink
          to="/admin/interviews/$interviewId"
          params={{ interviewId: interview.id }}
          variant="subtitle1"
          underline="hover"
          color="inherit"
          sx={{ fontWeight: 500, overflowWrap: "anywhere" }}
        >
          {interview.title}
        </TextLink>
        <Typography variant="body2" color="text.secondary">
          {details.join(" · ")}
        </Typography>
      </Stack>
      <Chip
        size="small"
        color={STATUS_COLORS[interview.status]}
        label={STATUS_LABELS[interview.status]}
        sx={{ alignSelf: { xs: "flex-start", sm: "center" } }}
      />
      <Stack sx={{ width: { sm: 120 }, flexShrink: 0 }}>
        <VisibilitySwitch interview={interview} />
      </Stack>
    </Stack>
  );
}
