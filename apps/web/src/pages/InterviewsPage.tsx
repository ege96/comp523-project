import Alert from "@mui/material/Alert";
import Container from "@mui/material/Container";
import Pagination from "@mui/material/Pagination";
import PaginationItem from "@mui/material/PaginationItem";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import type { ComponentProps } from "react";

import { interviewQueries } from "../api/client";
import { useAuth } from "../auth/useAuth";
import { InterviewList } from "../components/InterviewList";
import { TextLink } from "../components/links";

const route = getRouteApi("/interviews");
const PAGE_SIZE = 20;

/**
 * Every interview the viewer may see, most recently added first (the API sorts by created_at).
 * The API decides what that is.
 */
export function InterviewsPage() {
  const page = route.useSearch().page ?? 1;
  const { viewer } = useAuth();
  const { data, isPending, isError } = useQuery({
    ...interviewQueries.list(viewer, { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    enabled: viewer.ready,
    placeholderData: keepPreviousData,
  });
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <Container sx={{ pt: { xs: 3, md: 5 } }}>
      <Stack spacing={3}>
        <Stack spacing={1}>
          <Typography variant="h1">All interviews</Typography>
          <Typography color="text.secondary">
            Every public interview, most recently added first. To find a moment inside them,{" "}
            <TextLink to="/">search the transcripts</TextLink>.
          </Typography>
        </Stack>
        {isError ? (
          <Alert severity="error">Interviews couldn&apos;t be loaded. Please try again.</Alert>
        ) : isPending ? (
          <Skeleton variant="rectangular" height={480} />
        ) : data.items.length === 0 ? (
          <Typography color="text.secondary">
            {page > 1 ? "There are no more interviews." : "No interviews have been published yet."}
          </Typography>
        ) : (
          <InterviewList interviews={data.items} />
        )}
        {pages > 1 ? (
          <Pagination
            page={page}
            count={pages}
            shape="rounded"
            sx={{ alignSelf: "flex-start" }}
            renderItem={(item) => (
              <PaginationItem {...item} component={PageAnchor} toPage={item.page} />
            )}
          />
        ) : null}
      </Stack>
    </Container>
  );
}

// PaginationItem's own root, so it keeps its previous/next icons (a link made with createLink
// would swallow the `type` prop that picks them). Page 1 stays out of the URL.
function PageAnchor({ toPage, ...props }: { toPage: number | null } & ComponentProps<"a">) {
  return (
    <Link
      to="/interviews"
      search={{ page: toPage && toPage > 1 ? toPage : undefined }}
      {...props}
    />
  );
}
