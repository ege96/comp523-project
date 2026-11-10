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
import { TextLink } from "../components/links";
import { Plate } from "../components/Plate";
import { SearchBox } from "../components/SearchBox";

// Proposal: the home page shows the 5 most recently added interviews; the rest are a click away
// on /interviews. Search-first: no themes, featured items or recommendations (handoff, settled).
const RECENT_COUNT = 5;
const EXAMPLE = "How have festivals changed?";

export function HomePage() {
  return (
    <>
      <Plate pb={{ xs: 4, md: 5 }}>
        <Stack spacing={{ xs: 2.5, md: 3 }} sx={{ maxWidth: 820, pt: { md: 1 } }}>
          <Typography variant="overline" component="p" color="primary" sx={{ mb: -1 }}>
            Oral histories · Swayambhu, Kathmandu
          </Typography>
          <Typography
            variant="h1"
            sx={{
              fontSize: { xs: "2.25rem", md: "3.25rem" },
              maxWidth: "24ch",
              textWrap: "balance",
            }}
          >
            An archive of voices, memories and lived heritage.
          </Typography>
          <Typography
            variant="h6"
            component="p"
            color="text.secondary"
            sx={{ fontWeight: 400, maxWidth: "60ch" }}
          >
            Explore recorded interviews with people connected to Swayambhu. Search their words or
            their meaning, listen to their stories, and read along.
          </Typography>
          <Box>
            <SearchBox large />
            <Stack
              direction="row"
              useFlexGap
              sx={{
                mt: 1.5,
                justifyContent: "space-between",
                alignItems: "baseline",
                flexWrap: "wrap",
                columnGap: 3,
                rowGap: 1,
              }}
            >
              <Typography variant="body2" color="text.secondary">
                Try a question, like{" "}
                <TextLink to="/search" search={{ q: EXAMPLE }} sx={{ fontWeight: 600 }}>
                  {EXAMPLE}
                </TextLink>
              </Typography>
              <TextLink
                to="/interviews"
                variant="body2"
                underline="hover"
                sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, fontWeight: 600 }}
              >
                Browse all interviews <ArrowForwardIcon fontSize="small" aria-hidden />
              </TextLink>
            </Stack>
          </Box>
        </Stack>
      </Plate>

      <Container sx={{ pt: { xs: 4, md: 6 } }}>
        <Stack
          direction="row"
          sx={{
            justifyContent: "space-between",
            alignItems: "flex-end",
            flexWrap: "wrap",
            gap: 1,
            mb: 2,
          }}
        >
          <Box>
            <Typography variant="h2">Recently added</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              Interviews with timestamped transcripts. English translations are shown when
              available.
            </Typography>
          </Box>
          <TextLink
            to="/interviews"
            underline="hover"
            sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, fontWeight: 600 }}
          >
            Browse all interviews <ArrowForwardIcon fontSize="small" aria-hidden />
          </TextLink>
        </Stack>
        <RecentInterviews />
      </Container>
    </>
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
  if (isPending) return <Skeleton variant="rectangular" height={320} />;
  if (data.items.length === 0) {
    return (
      <Box sx={{ py: 4, borderTop: 1, borderColor: "divider" }}>
        <Typography color="text.secondary">No interviews have been published yet.</Typography>
      </Box>
    );
  }
  return <InterviewList interviews={data.items} />;
}
