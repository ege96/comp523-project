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
import { tokens } from "../theme";

// Proposal: the home page shows the 5 most recently added interviews; the rest are a click away
// on /interviews. Search-first: no themes, featured items or recommendations (handoff, settled).
const RECENT_COUNT = 5;
const EXAMPLE = "How have festivals changed?";

export function HomePage() {
  return (
    <>
      <Plate pb={{ xs: 5, md: 7 }}>
        <Stack spacing={{ xs: 2.5, md: 3 }} sx={{ maxWidth: 820, pt: { md: 2 } }}>
          <Typography
            variant="h1"
            sx={{
              fontSize: { xs: "1.75rem", md: "2.5rem" },
              maxWidth: "26ch",
              textWrap: "balance",
            }}
          >
            Search what people remember about Swayambhu.
          </Typography>
          <Typography sx={{ color: tokens.onPlateMuted, maxWidth: "60ch" }}>
            Recorded interviews in Nepali, Nepal Bhasa and English. Search their words or their
            meaning, then listen from the exact moment it was said.
          </Typography>
          <SearchBox large />
          <Typography variant="body2" sx={{ color: tokens.onPlateMuted }}>
            Try a question, like{" "}
            <TextLink
              to="/search"
              search={{ q: EXAMPLE }}
              sx={{
                color: tokens.onPlate,
                fontWeight: 600,
                textDecorationColor: tokens.onPlateMuted,
              }}
            >
              {EXAMPLE}
            </TextLink>
          </Typography>
        </Stack>
      </Plate>

      <Container sx={{ pt: { xs: 5, md: 7 } }}>
        <Stack
          direction="row"
          sx={{
            justifyContent: "space-between",
            alignItems: "baseline",
            flexWrap: "wrap",
            gap: 1,
            mb: 2,
          }}
        >
          <Typography variant="h2">Recently added</Typography>
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
      <Box sx={{ py: 4, borderTop: 2, borderColor: "text.primary" }}>
        <Typography color="text.secondary">No interviews have been published yet.</Typography>
      </Box>
    );
  }
  return <InterviewList interviews={data.items} />;
}
