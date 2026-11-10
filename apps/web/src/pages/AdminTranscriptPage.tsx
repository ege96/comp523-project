import Alert from "@mui/material/Alert";
import Container from "@mui/material/Container";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";

import { TranscriptEditor } from "../admin/TranscriptEditor";
import { ApiError, interviewQueries } from "../api/client";
import { useAuth } from "../auth/useAuth";
import { ArrowBackIcon } from "../components/icons";
import { TextLink } from "../components/links";

const route = getRouteApi("/admin/interviews/$interviewId/transcript");

/** The transcript editor on a page of its own, so a long transcript has room. */
export function AdminTranscriptPage() {
  const { interviewId } = route.useParams();
  const { viewer } = useAuth();
  const { data, error } = useQuery({
    ...interviewQueries.detail(viewer, interviewId),
    enabled: viewer.ready,
  });

  return (
    <Container maxWidth="md" sx={{ pt: { xs: 3, md: 5 }, pb: 6 }}>
      <Stack spacing={2.5}>
        <TextLink
          to="/admin/interviews/$interviewId"
          params={{ interviewId }}
          variant="body2"
          underline="hover"
          sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, alignSelf: "flex-start" }}
        >
          <ArrowBackIcon fontSize="small" aria-hidden /> {data ? data.title : "Back"}
        </TextLink>
        {data ? (
          <>
            <Stack spacing={1}>
              <Typography variant="h1">Transcript</Typography>
              <Typography color="text.secondary" sx={{ maxWidth: "65ch" }}>
                Play the recording and follow along. When a line is wrong, press “Edit the line
                playing” or click the line. Enter saves, Tab saves and opens the next line. The
                machine text is kept, so any line can go back to it.
              </Typography>
            </Stack>
            <TranscriptEditor interview={data} />
          </>
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
