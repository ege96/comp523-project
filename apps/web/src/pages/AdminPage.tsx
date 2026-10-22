import Box from "@mui/material/Box";
import Container from "@mui/material/Container";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { getRouteApi } from "@tanstack/react-router";

import { AdminInterviewList } from "../admin/AdminInterviewList";
import { UploadCard } from "../admin/UploadCard";
import { useAuth } from "../auth/useAuth";

const route = getRouteApi("/admin/");

/** Upload recordings, follow their processing and choose who can see them. */
export function AdminPage() {
  const { state } = useAuth();
  const { status, page = 1 } = route.useSearch();
  const navigate = route.useNavigate();
  return (
    <Container sx={{ py: 6 }}>
      <Stack spacing={4}>
        <Stack spacing={1}>
          <Typography variant="h1">Upload &amp; review</Typography>
          <Typography color="text.secondary">
            Add recordings, follow their processing, then choose who can see them. Signed in as{" "}
            {state.status === "signedIn" ? state.email : null}.
          </Typography>
        </Stack>
        <Box
          sx={{
            display: "grid",
            gap: 3,
            gridTemplateColumns: { xs: "minmax(0, 1fr)", lg: "5fr 7fr" },
            alignItems: "start",
          }}
        >
          <UploadCard />
          <AdminInterviewList
            status={status}
            page={page}
            onChange={(next) => {
              void navigate({
                search: { status: next.status, page: next.page > 1 ? next.page : undefined },
              });
            }}
          />
        </Box>
      </Stack>
    </Container>
  );
}
