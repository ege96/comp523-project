import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Container from "@mui/material/Container";
import Pagination from "@mui/material/Pagination";
import PaginationItem from "@mui/material/PaginationItem";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import type { ComponentProps } from "react";

import { interviewQueries, type InterviewFilters } from "../api/client";
import { useAuth } from "../auth/useAuth";
import { FilterPanel, FilterSummary } from "../components/FilterPanel";
import { isFiltered, pickFilters } from "../filters";
import { InterviewList } from "../components/InterviewList";
import { TextLink } from "../components/links";

const route = getRouteApi("/interviews");
const PAGE_SIZE = 20;

// The filters inside a list query's key.
const filterKey = (queryKey: readonly unknown[]) =>
  JSON.stringify((queryKey[3] as { filters: InterviewFilters }).filters);

/**
 * Every interview the viewer may see, most recently added first (the API sorts by created_at),
 * narrowed by the same filters as search. The API decides what the viewer may see.
 */
export function InterviewsPage() {
  const { page: pageParam, ...search } = route.useSearch();
  const page = pageParam ?? 1;
  const filters = pickFilters(search);
  const filtered = isFiltered(filters);
  const navigate = useNavigate();
  const { viewer } = useAuth();
  const { data, isPending, isError, isFetching } = useQuery({
    ...interviewQueries.list(viewer, {
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
      filters,
    }),
    enabled: viewer.ready,
    // Paging within the same filters keeps the old rows while the next page loads; new
    // filters never show rows that answer a different request.
    placeholderData: (previous, previousQuery) =>
      previousQuery && filterKey(previousQuery.queryKey) === JSON.stringify(filters)
        ? previous
        : undefined,
  });
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  // New filters start again at page 1.
  const clearFilters = () => void navigate({ to: "/interviews", search: {} });

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
        <Box
          sx={{
            display: "grid",
            gap: { xs: 3, md: 6 },
            gridTemplateColumns: { md: "15rem minmax(0, 1fr)" },
            alignItems: "start",
          }}
        >
          {/* key: going back or forward resets the uncontrolled filter fields to the URL. */}
          <FilterPanel
            key={JSON.stringify(filters)}
            filters={filters}
            heading="Filter interviews"
            onApply={(applied) => void navigate({ to: "/interviews", search: applied })}
            onClear={clearFilters}
          />
          <Stack spacing={2}>
            <FilterSummary filters={filters} onClear={clearFilters} />
            <Box aria-busy={isFetching}>
              {isError ? (
                <Alert severity="error">
                  Interviews couldn&apos;t be loaded. Please try again.
                </Alert>
              ) : isPending ? (
                <Skeleton variant="rectangular" height={480} />
              ) : data.items.length === 0 ? (
                <Typography color="text.secondary">
                  {page > 1
                    ? "There are no more interviews."
                    : filtered
                      ? "No interviews match these filters. Try fewer filters."
                      : "No interviews have been published yet."}
                </Typography>
              ) : (
                <InterviewList interviews={data.items} />
              )}
            </Box>
            {pages > 1 ? (
              <Pagination
                page={page}
                count={pages}
                shape="rounded"
                sx={{ alignSelf: "flex-start" }}
                renderItem={(item) => (
                  <PaginationItem
                    {...item}
                    component={PageAnchor}
                    nativeButton={false}
                    role="link"
                    toPage={item.page}
                    filters={filters}
                  />
                )}
              />
            ) : null}
          </Stack>
        </Box>
      </Stack>
    </Container>
  );
}

// PaginationItem's own root, so it keeps its previous/next icons (a link made with createLink
// would swallow the `type` prop that picks them). Page 1 stays out of the URL.
function PageAnchor({
  toPage,
  filters,
  ...props
}: { toPage: number | null; filters: InterviewFilters } & ComponentProps<"a">) {
  return (
    <Link
      to="/interviews"
      search={{ ...filters, page: toPage && toPage > 1 ? toPage : undefined }}
      {...props}
    />
  );
}
