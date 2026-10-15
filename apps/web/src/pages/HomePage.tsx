import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Container from "@mui/material/Container";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useQuery } from "@tanstack/react-query";

import { interviewQueries } from "../api/client";
import { useAuth } from "../auth/useAuth";
import { ArrowForwardIcon } from "../components/icons";
import { InterviewList } from "../components/InterviewList";
import { ButtonLink } from "../components/links";
import { SearchBox } from "../components/SearchBox";

// Proposal: the home page shows the 5 most recently added interviews; the rest are a click away
// on /interviews. Search-first: no themes, featured items or recommendations (handoff, settled).
const RECENT_COUNT = 5;

export function HomePage() {
  return (
    <Container sx={{ py: { xs: 5, md: 8 } }}>
      <Stack spacing={3} sx={{ maxWidth: 900, mb: { xs: 7, md: 10 } }}>
        <Typography variant="overline" color="primary" sx={{ fontWeight: 600 }}>
          Oral histories · Swayambhu, Kathmandu
        </Typography>
        <Typography
          variant="h1"
          sx={{ fontSize: { xs: "2.5rem", md: "3.5rem" }, lineHeight: 1.15 }}
        >
          An archive of voices, memories and lived heritage.
        </Typography>
        <Typography variant="h6" component="p" color="text.secondary" sx={{ fontWeight: 400 }}>
          Explore recorded interviews with people connected to Swayambhu. Search their words, listen
          to their stories, and read along.
        </Typography>
        <Box>
          <SearchBox />
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
            Search finds moments by meaning as well as exact words, in the original transcripts and
            their English translations. Try a question, like “How have festivals changed?”
          </Typography>
        </Box>
        <Box>
          <ButtonLink to="/interviews" variant="outlined" endIcon={<ArrowForwardIcon />}>
            Browse all interviews
          </ButtonLink>
        </Box>
      </Stack>

      <Stack
        direction={{ xs: "column", sm: "row" }}
        spacing={2}
        sx={{ justifyContent: "space-between", alignItems: { sm: "flex-end" }, mb: 3 }}
      >
        <Box>
          <Typography variant="h2" gutterBottom>
            Recently added interviews
          </Typography>
          <Typography color="text.secondary">
            Original recordings with timestamped transcripts. English translations are shown when
            available.
          </Typography>
        </Box>
        <ButtonLink
          to="/interviews"
          endIcon={<ArrowForwardIcon />}
          sx={{ flexShrink: 0, alignSelf: { xs: "flex-start", sm: "auto" } }}
        >
          View all interviews
        </ButtonLink>
      </Stack>
      <RecentInterviews />
    </Container>
  );
}

function RecentInterviews() {
  const { viewer } = useAuth();
  const { data, isPending, isError } = useQuery({
    ...interviewQueries.list(viewer, { limit: RECENT_COUNT }),
    enabled: viewer.ready,
  });
  if (isError)
    return <Alert severity="error">Interviews couldn&apos;t be loaded. Please try again.</Alert>;
  if (isPending) return <Skeleton variant="rounded" height={320} />;
  if (data.items.length === 0) {
    return <Typography color="text.secondary">No interviews have been published yet.</Typography>;
  }
  return <InterviewList interviews={data.items} />;
}
