import Alert from "@mui/material/Alert";
import Container from "@mui/material/Container";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import Paper from "@mui/material/Paper";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useQuery } from "@tanstack/react-query";

import { interviewQueries } from "../api/client";
import type { InterviewSummary } from "../api/schemas";
import { useAuth } from "../auth/useAuth";
import { InterviewChips } from "../components/InterviewChips";
import { TextLink } from "../components/links";
import { SearchBox } from "../components/SearchBox";
import { formatClock, formatRecordedOn } from "../format";

export function HomePage() {
  return (
    <Container sx={{ py: 6 }}>
      <Stack spacing={2} sx={{ maxWidth: 720, mb: 8 }}>
        <Typography variant="overline" color="primary">
          Oral histories · Swayambhu, Kathmandu
        </Typography>
        <Typography variant="h1">Swayambhu Stories</Typography>
        <Typography color="text.secondary">
          Recorded interviews with people connected to Swayambhu. Search their words, listen to
          their stories, and read along.
        </Typography>
        <SearchBox />
      </Stack>
      <Typography variant="h2" gutterBottom>
        Recently added interviews
      </Typography>
      <RecentInterviews />
    </Container>
  );
}

function RecentInterviews() {
  const { viewer } = useAuth();
  const { data, isPending, isError } = useQuery({
    ...interviewQueries.recent(viewer),
    enabled: viewer.ready,
  });
  if (isError)
    return <Alert severity="error">Interviews couldn&apos;t be loaded. Please try again.</Alert>;
  if (isPending) return <Skeleton variant="rounded" height={160} />;
  if (data.items.length === 0) {
    return <Typography color="text.secondary">No interviews have been published yet.</Typography>;
  }
  return (
    <Paper>
      <List disablePadding>
        {data.items.map((interview, i) => (
          <ListItem key={interview.id} divider={i < data.items.length - 1} sx={{ py: 2 }}>
            <InterviewRow interview={interview} />
          </ListItem>
        ))}
      </List>
    </Paper>
  );
}

function InterviewRow({ interview }: { interview: InterviewSummary }) {
  const recorded = formatRecordedOn(interview);
  const details = [
    interview.interviewee ?? "Unknown interviewee",
    interview.primary_language?.name,
    interview.duration_ms === null ? null : formatClock(interview.duration_ms),
    recorded ? `Recorded ${recorded}` : null,
  ].filter(Boolean);
  return (
    <Stack spacing={0.5}>
      <TextLink
        to="/interviews/$interviewId"
        params={{ interviewId: interview.id }}
        variant="subtitle1"
        underline="hover"
        color="inherit"
      >
        {interview.title}
      </TextLink>
      <Typography variant="body2" color="text.secondary">
        {details.join(" · ")}
      </Typography>
      <InterviewChips interview={interview} />
    </Stack>
  );
}
