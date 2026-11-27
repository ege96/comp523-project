import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Container from "@mui/material/Container";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useInfiniteQuery } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { searchQueries, type SearchParams } from "../api/client";
import { useAuth } from "../auth/useAuth";
import { TextLink } from "../components/links";
import { FilterPanel, FilterSummary } from "../components/FilterPanel";
import { isFiltered, pickFilters } from "../filters";
import { InterviewList } from "../components/InterviewList";
import { MomentCard } from "../components/MomentCard";
import { Plate } from "../components/Plate";
import { SearchBox } from "../components/SearchBox";
import { visuallyHidden } from "../components/visuallyHidden";

const route = getRouteApi("/search");

export function SearchPage() {
  const { q, ...filters } = route.useSearch();
  const params = { q, ...filters };
  const navigate = useNavigate();
  // One polite status line for the whole page, always mounted so screen readers hear changes.
  const [status, setStatus] = useState("");
  return (
    <>
      <Plate>
        <Stack spacing={2.5} sx={{ maxWidth: 820 }}>
          <Typography variant="h1" sx={{ fontSize: { xs: "1.75rem", md: "2.25rem" } }}>
            Search the archive
          </Typography>
          {/* key: a new query in the URL resets the uncontrolled field. */}
          <SearchBox key={q} defaultValue={q} filters={filters} />
        </Stack>
      </Plate>
      <Box role="status" aria-live="polite" sx={visuallyHidden}>
        {q ? status : ""}
      </Box>
      <Container sx={{ pt: { xs: 3, md: 5 } }}>
        {q ? (
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
              key={JSON.stringify(params)}
              filters={filters}
              heading="Filter results"
              onApply={(applied) => void navigate({ to: "/search", search: { q, ...applied } })}
              onClear={() => void navigate({ to: "/search", search: { q } })}
              note="Results are moments in transcripts. Several moments may come from the same interview."
            />
            <Results params={params} onStatus={setStatus} />
          </Box>
        ) : (
          <Typography color="text.secondary" sx={{ maxWidth: "60ch" }}>
            Search finds moments by meaning as well as by exact words, in the original transcripts
            and their English translations. Or{" "}
            <TextLink to="/interviews">browse all interviews</TextLink>.
          </Typography>
        )}
      </Container>
    </>
  );
}

function Results({
  params,
  onStatus,
}: {
  params: SearchParams;
  onStatus: (message: string) => void;
}) {
  const { viewer } = useAuth();
  const navigate = useNavigate();
  const {
    data,
    isError,
    isFetchNextPageError,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
    isFetching,
  } = useInfiniteQuery({ ...searchQueries.moments(viewer, params), enabled: viewer.ready });
  const filtered = isFiltered(params);
  const clearFilters = () => void navigate({ to: "/search", search: { q: params.q } });

  const moments = data?.pages.flatMap((page) => page.items) ?? [];
  const pageCount = data?.pages.length ?? 0;
  // Interviews whose title, description, people or place match come with the first page.
  const interviews = data?.pages[0]?.interviews ?? [];
  const moreInterviews = data?.pages[0]?.more_metadata_matches ?? false;

  // Never a count (product rule): just what changed.
  const message =
    data === undefined
      ? isError
        ? "" // The error Alert speaks for itself.
        : "Searching transcripts…"
      : moments.length === 0 && interviews.length === 0
        ? "No interviews or moments matched"
        : moments.length === 0
          ? "Interviews matched, no transcript moments"
          : pageCount > 1
            ? "More moments loaded"
            : "Results updated";
  useEffect(() => {
    onStatus(message);
  }, [message, onStatus]);

  // A new query or new filters move focus to the results heading, so keyboard users keep
  // their place; the first search on arriving leaves focus where the browser put it.
  const key = JSON.stringify(params);
  const focusedFor = useRef(key);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusedFor.current !== key && heading.current && !isFetching) {
      focusedFor.current = key;
      heading.current.focus();
    }
  });

  // "Show more" keeps focus on its button; when it was the last page the button goes, so
  // focus moves to the first new moment's link instead.
  const list = useRef<HTMLDivElement>(null);
  const loadedFrom = useRef<number | null>(null);
  useEffect(() => {
    const from = loadedFrom.current;
    if (from === null || isFetchingNextPage) return;
    loadedFrom.current = null;
    if (!hasNextPage && from < moments.length)
      list.current?.children[from]?.querySelector<HTMLElement>("a")?.focus();
  });

  if (data === undefined) {
    return isError ? (
      <Alert severity="error">Search isn&apos;t working right now. Please try again.</Alert>
    ) : (
      <Skeleton variant="rectangular" height={400} />
    );
  }

  const keywordOnly = data.pages.some((page) => page.search_mode === "keyword_only");
  return (
    <Stack spacing={2} component="section" aria-labelledby="results-heading">
      <Typography
        variant="h2"
        sx={{ fontSize: "1.5rem" }}
        id="results-heading"
        ref={heading}
        tabIndex={-1}
      >
        Search results
      </Typography>
      {/* With no results the button sits by that message instead, so there's only one. */}
      <FilterSummary
        filters={pickFilters(params)}
        onClear={clearFilters}
        showClear={moments.length > 0}
      />
      {interviews.length > 0 ? (
        <Stack spacing={1} component="section" aria-labelledby="interview-matches-heading">
          <Typography variant="subtitle1" component="h3" id="interview-matches-heading">
            Top interviews matching your words
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Found in the title, description, interviewee, interviewer or place.
          </Typography>
          <InterviewList interviews={interviews} />
          {moreInterviews ? (
            <Typography variant="body2" color="text.secondary">
              More interviews match than are shown here. Add words or filters to narrow them down.
            </Typography>
          ) : null}
        </Stack>
      ) : null}
      <Box component="section" aria-labelledby="moments-heading">
        <Typography variant="subtitle1" component="h3" id="moments-heading">
          Relevant transcript moments
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Most relevant first. Each shows the original words, with the English below when there is a
          translation. Transcribed and translated by machine; lines may contain errors.
        </Typography>
      </Box>
      {keywordOnly ? (
        <Alert severity="info">
          Searching by meaning isn&apos;t available right now, so these results only match your
          words.
        </Alert>
      ) : null}
      {moments.length === 0 ? (
        <Stack spacing={1} sx={{ alignItems: "flex-start" }}>
          <Typography color="text.secondary">
            No transcript moments matched. Try different words, a question, or fewer filters.
          </Typography>
          {filtered ? (
            <Button variant="outlined" onClick={clearFilters}>
              Clear filters
            </Button>
          ) : null}
        </Stack>
      ) : (
        <>
          <Stack spacing={2} ref={list}>
            {moments.map((moment) => (
              <MomentCard
                key={`${moment.interview.id}:${String(moment.start_ms)}`}
                moment={moment}
              />
            ))}
          </Stack>
          {hasNextPage ? (
            <Stack spacing={1.5} sx={{ alignItems: "flex-start" }}>
              {isFetchNextPageError ? (
                <Alert severity="error">
                  More moments couldn&apos;t be loaded. The ones above are still here.
                </Alert>
              ) : null}
              {/* Not disabled while loading, so it keeps keyboard focus. */}
              <Button
                variant="outlined"
                aria-busy={isFetchingNextPage}
                onClick={() => {
                  if (isFetchingNextPage) return;
                  loadedFrom.current = moments.length;
                  void fetchNextPage();
                }}
              >
                {isFetchingNextPage
                  ? "Loading…"
                  : isFetchNextPageError
                    ? "Try loading more again"
                    : "Show more moments"}
              </Button>
            </Stack>
          ) : (
            <Typography variant="body2" color="text.secondary">
              End of results. Try a different question or broaden your filters.
            </Typography>
          )}
        </>
      )}
    </Stack>
  );
}
