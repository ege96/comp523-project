import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Container from "@mui/material/Container";
import Divider from "@mui/material/Divider";
import FormControlLabel from "@mui/material/FormControlLabel";
import FormHelperText from "@mui/material/FormHelperText";
import MenuItem from "@mui/material/MenuItem";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type SubmitEvent } from "react";

import { searchQueries, type SearchParams } from "../api/client";
import { useAuth } from "../auth/useAuth";
import { ChevronIcon } from "../components/icons";
import { TextLink } from "../components/links";
import { MomentCard } from "../components/MomentCard";
import { Plate } from "../components/Plate";
import { SearchBox } from "../components/SearchBox";
import { visuallyHidden } from "../components/visuallyHidden";

const route = getRouteApi("/search");

// Show the "All …" choice (value "") as the selection rather than an empty box.
const allOption = { select: { displayEmpty: true }, inputLabel: { shrink: true } } as const;

export function SearchPage() {
  const { q, ...filters } = route.useSearch();
  const params = { q, ...filters };
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
            <Filters key={JSON.stringify(params)} params={params} />
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

const isFiltered = (p: SearchParams) =>
  p.language !== undefined ||
  p.interviewee !== undefined ||
  p.from !== undefined ||
  p.to !== undefined;

/** Uncontrolled: the choices only matter when applied, and then they go into the URL. */
function Filters({ params }: { params: SearchParams }) {
  const { viewer } = useAuth();
  const navigate = useNavigate();
  // Choices come only from interviews this viewer may see (the API filters them).
  const { data, isError } = useQuery({ ...searchQueries.filters(viewer), enabled: viewer.ready });
  const active = [params.language, params.interviewee, params.from ?? params.to].filter(
    (v) => v !== undefined,
  ).length;
  const filtered = active > 0;
  // On phones the filters fold away above the results; on wide screens they stay open.
  const [open, setOpen] = useState(false);
  // "Undated" only means something next to a year range, so it waits for a year.
  const [years, setYears] = useState({
    from: params.from?.slice(0, 4) ?? "",
    to: params.to?.slice(0, 4) ?? "",
  });
  const hasYear = Boolean(years.from.trim() || years.to.trim());

  const apply = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (name: string) => {
      const value = form.get(name);
      return typeof value === "string" && value ? value : undefined;
    };
    const interviewee = text("interviewee");
    // Years typed the wrong way round still mean the span between them.
    const span = [text("fromYear"), text("toYear")];
    if (span[0] && span[1] && span[0] > span[1]) span.reverse();
    const from = span[0] && `${span[0]}-01-01`;
    const to = span[1] && `${span[1]}-12-31`;
    void navigate({
      to: "/search",
      search: {
        q: params.q,
        language: text("language"),
        interviewee:
          interviewee === undefined || interviewee === "unknown"
            ? interviewee
            : Number(interviewee),
        from,
        to,
        undated: (from ?? to) && form.get("undated") ? true : undefined,
      },
    });
  };

  return (
    <Box sx={{ position: { md: "sticky" }, top: { md: 24 } }}>
      <Button
        variant="outlined"
        aria-expanded={open}
        aria-controls="search-filters"
        onClick={() => {
          setOpen(!open);
        }}
        sx={{
          display: { md: "none" },
          width: 1,
          justifyContent: "space-between",
          color: "text.primary",
        }}
        endIcon={<ChevronIcon sx={{ transform: open ? "rotate(180deg)" : undefined }} />}
      >
        {filtered ? `Filters · ${String(active)} on` : "Filters"}
      </Button>
      <Stack
        component="form"
        id="search-filters"
        spacing={2.5}
        onSubmit={apply}
        aria-label="Filter results"
        sx={{ display: { xs: open ? "flex" : "none", md: "flex" }, mt: { xs: 2, md: 0 } }}
      >
        <Typography
          variant="subtitle1"
          component="h2"
          sx={{ display: { xs: "none", md: "block" } }}
        >
          Filter results
        </Typography>
        {isError ? <Alert severity="warning">Filter choices couldn&apos;t be loaded.</Alert> : null}
        <TextField
          select
          name="language"
          slotProps={allOption}
          label="Language"
          defaultValue={params.language ?? ""}
          helperText="Any language heard in the interview"
        >
          <MenuItem value="">All languages</MenuItem>
          {data?.languages.map((l) => (
            <MenuItem key={l.code} value={l.code}>
              {l.name}
            </MenuItem>
          ))}
          {/* Keeps a value from a shared link selectable before (or without) the list. */}
          {params.language && !data?.languages.some((l) => l.code === params.language) ? (
            <MenuItem value={params.language}>{params.language}</MenuItem>
          ) : null}
        </TextField>
        <TextField
          select
          name="interviewee"
          slotProps={allOption}
          label="Interviewee"
          defaultValue={params.interviewee === undefined ? "" : String(params.interviewee)}
        >
          <MenuItem value="">All interviewees</MenuItem>
          {data?.interviewees.map((p) => (
            <MenuItem key={p.id} value={String(p.id)}>
              {p.name}
            </MenuItem>
          ))}
          <MenuItem value="unknown">Unknown</MenuItem>
          {typeof params.interviewee === "number" &&
          !data?.interviewees.some((p) => p.id === params.interviewee) ? (
            <MenuItem value={String(params.interviewee)}>Interviewee {params.interviewee}</MenuItem>
          ) : null}
        </TextField>
        <Stack spacing={1.5}>
          <Typography variant="body2" component="p" sx={{ fontWeight: 600 }}>
            Recording date
          </Typography>
          {/* Proposal: whole years, like the rest of the app's dates; most are known only
              to the year. The URL keeps full dates, so a shared link still works. */}
          <Stack direction="row" spacing={1.5}>
            <TextField
              name="fromYear"
              label="From year"
              defaultValue={years.from}
              onChange={(e) => {
                setYears({ ...years, from: e.target.value });
              }}
              slotProps={{ htmlInput: { inputMode: "numeric", pattern: "[0-9]{4}", maxLength: 4 } }}
              sx={{ flex: 1, minWidth: 0 }}
            />
            <TextField
              name="toYear"
              label="To year"
              defaultValue={years.to}
              onChange={(e) => {
                setYears({ ...years, to: e.target.value });
              }}
              slotProps={{ htmlInput: { inputMode: "numeric", pattern: "[0-9]{4}", maxLength: 4 } }}
              sx={{ flex: 1, minWidth: 0 }}
            />
          </Stack>
          <Box>
            <FormControlLabel
              control={
                <Checkbox
                  name="undated"
                  defaultChecked={params.undated ?? false}
                  slotProps={{ input: { "aria-describedby": "undated-help" } }}
                />
              }
              disabled={!hasYear}
              label="Also show undated interviews"
              slotProps={{ typography: { variant: "body2" } }}
            />
            <FormHelperText id="undated-help" sx={{ mt: 0 }}>
              Only applies with a year range.
            </FormHelperText>
          </Box>
        </Stack>
        <Stack direction="row" spacing={1}>
          <Button type="submit" variant="outlined">
            Apply filters
          </Button>
          {filtered ? (
            <Button onClick={() => void navigate({ to: "/search", search: { q: params.q } })}>
              Clear
            </Button>
          ) : null}
        </Stack>
        <Divider />
        <Typography variant="body2" color="text.secondary">
          Results are moments in transcripts. Several moments may come from the same interview.
        </Typography>
      </Stack>
    </Box>
  );
}

/** The applied filters in words, e.g. "Nepali · Interviewee 7 · 1990–2001". */
function useFilterSummary(params: SearchParams): string[] {
  const { viewer } = useAuth();
  const { data } = useQuery({ ...searchQueries.filters(viewer), enabled: viewer.ready });
  const parts: string[] = [];
  if (params.language !== undefined) {
    const code = params.language;
    parts.push(data?.languages.find((l) => l.code === code)?.name ?? code);
  }
  if (params.interviewee === "unknown") parts.push("Unknown interviewee");
  else if (params.interviewee !== undefined) {
    const id = params.interviewee;
    parts.push(data?.interviewees.find((p) => p.id === id)?.name ?? `Interviewee ${String(id)}`);
  }
  const from = params.from?.slice(0, 4);
  const to = params.to?.slice(0, 4);
  if (from && to) parts.push(from === to ? from : `${from}–${to}`);
  else if (from) parts.push(`From ${from}`);
  else if (to) parts.push(`Up to ${to}`);
  if ((from ?? to) && params.undated) parts.push("and undated");
  return parts;
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
  const summary = useFilterSummary(params);
  const filtered = isFiltered(params);
  const clearFilters = () => void navigate({ to: "/search", search: { q: params.q } });

  const moments = data?.pages.flatMap((page) => page.items) ?? [];
  const pageCount = data?.pages.length ?? 0;

  // Never a count (product rule): just what changed.
  const message =
    data === undefined
      ? isError
        ? "" // The error Alert speaks for itself.
        : "Searching transcripts…"
      : moments.length === 0
        ? "No moments matched"
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
      <Box>
        <Typography
          variant="subtitle1"
          component="h2"
          id="results-heading"
          ref={heading}
          tabIndex={-1}
        >
          Relevant transcript moments
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Most relevant first. Each shows the original words, with the English below when there is a
          translation. Transcribed and translated by machine; lines may contain errors.
        </Typography>
      </Box>
      {filtered ? (
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ alignItems: "center", flexWrap: "wrap" }}
        >
          <Typography variant="body2">
            <Box component="span" sx={{ color: "text.secondary" }}>
              Filtered by:{" "}
            </Box>
            {summary.join(" · ")}
          </Typography>
          {/* With no results the button sits by that message instead, so there's only one. */}
          {moments.length > 0 ? (
            <Button size="small" onClick={clearFilters}>
              Clear filters
            </Button>
          ) : null}
        </Stack>
      ) : null}
      {keywordOnly ? (
        <Alert severity="info">
          Searching by meaning isn&apos;t available right now, so these results only match your
          words.
        </Alert>
      ) : null}
      {moments.length === 0 ? (
        <Stack spacing={1} sx={{ alignItems: "flex-start" }}>
          <Typography color="text.secondary">
            No moments matched. Try different words, a question, or fewer filters.
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
