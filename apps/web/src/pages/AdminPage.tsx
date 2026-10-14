import Alert from "@mui/material/Alert";
import Container from "@mui/material/Container";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

import { useAuth } from "../auth/useAuth";

/** Placeholder for upload and review, which arrive with the upload API. */
export function AdminPage() {
  const { state } = useAuth();
  return (
    <Container sx={{ py: 6 }}>
      <Stack spacing={2}>
        <Typography variant="h1">Upload &amp; review</Typography>
        <Typography color="text.secondary">
          Signed in as {state.status === "signedIn" ? state.email : null}.
        </Typography>
        <Alert severity="info">Uploading and reviewing interviews is coming next.</Alert>
      </Stack>
    </Container>
  );
}
