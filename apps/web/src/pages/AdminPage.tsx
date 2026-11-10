import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Container from "@mui/material/Container";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { getRouteApi } from "@tanstack/react-router";

import { AdminInterviewList } from "../admin/AdminInterviewList";
import { UploadCard } from "../admin/UploadCard";
import { useAuth } from "../auth/useAuth";
import { UploadIcon } from "../components/icons";

const route = getRouteApi("/admin/");

/** Add recordings, see what each one needs next, and publish them. */
export function AdminPage() {
  const { state } = useAuth();
  const { view, page = 1 } = route.useSearch();
  const navigate = route.useNavigate();
  return (
    <Container sx={{ py: { xs: 4, md: 6 } }}>
      <Stack spacing={{ xs: 3, md: 4 }}>
        <Stack
          direction={{ xs: "column", sm: "row" }}
          spacing={1}
          sx={{ justifyContent: "space-between", alignItems: { sm: "flex-end" } }}
        >
          <Stack spacing={1}>
            <Typography variant="h1">Upload &amp; review</Typography>
            <Typography color="text.secondary" sx={{ maxWidth: "60ch" }}>
              Add interviews, check their transcripts, then publish them for visitors.
            </Typography>
          </Stack>
          <Stack spacing={1.5} sx={{ alignItems: { sm: "flex-end" } }}>
            {state.status === "signedIn" ? (
              <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
                Signed in as {state.email}
              </Typography>
            ) : null}
            {/* Below lg the upload form sits under the list, so offer a way straight to it. */}
            <Button
              href="#add-interview"
              variant="outlined"
              startIcon={<UploadIcon aria-hidden />}
              sx={{ display: { lg: "none" }, alignSelf: { xs: "flex-start", sm: "flex-end" } }}
            >
              Add an interview
            </Button>
          </Stack>
        </Stack>
        <Box
          sx={{
            display: "grid",
            gap: 3,
            gridTemplateColumns: { xs: "minmax(0, 1fr)", lg: "minmax(0, 4fr) minmax(0, 7fr)" },
            alignItems: "start",
          }}
        >
          {/* On a phone the interviews come first: checking on them is the common visit. */}
          <Box id="add-interview" sx={{ order: { xs: 2, lg: 1 }, scrollMarginTop: 16 }}>
            <UploadCard />
          </Box>
          <Box sx={{ order: { xs: 1, lg: 2 } }}>
            <AdminInterviewList
              view={view}
              page={page}
              onChange={(next) => {
                void navigate({
                  search: { view: next.view, page: next.page > 1 ? next.page : undefined },
                });
              }}
            />
          </Box>
        </Box>
      </Stack>
    </Container>
  );
}
