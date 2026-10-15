import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Container from "@mui/material/Container";
import Divider from "@mui/material/Divider";
import FormControlLabel from "@mui/material/FormControlLabel";
import MenuItem from "@mui/material/MenuItem";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import type { SubmitEvent } from "react";

import { searchQueries, type SearchParams } from "../api/client";
import { useAuth } from "../auth/useAuth";
import { MomentCard } from "../components/MomentCard";
import { SearchBox } from "../components/SearchBox";

const route = getRouteApi("/search");

// Show the "All …" choice (value "") as the selection rather than an empty box.
const allOption = { select: { displayEmpty: true }, inputLabel: { shrink: true } } as const;

export function SearchPage() {
  const params = route.useSearch();
  return (
    <Container sx={{ py: 6 }}>
      <Stack spacing={4}>
        <Typography variant="h1">Search the archive</Typography>
        {/* key: a new query in the URL resets the uncontrolled field. */}
        <SearchBox key={params.q} defaultValue={params.q} />
        {params.q ? (
          <Box
            sx={{
              display: "grid",
              gap: { xs: 4, md: 5 },
              gridTemplateColumns: { md: "260px 1fr" },
              alignItems: "start",
            }}
          >
            {/* key: going back or forward resets the uncontrolled filter fields to the URL. */}
            <Filters key={JSON.stringify(params)} params={params} />
            <Results params={params} />
          </Box>
        ) : (
          <Typography color="text.secondary">
            Type a question or some words to find moments in the interview transcripts.
          </Typography>
        )}
      </Stack>
    </Container>
  );
}

/** Uncontrolled: the choices only matter when applied, and then they go into the URL. */
function Filters({ params }: { params: SearchParams }) {
  const { viewer } = useAuth();
  const navigate = useNavigate();
  // Choices come only from interviews this viewer may see (the API filters them).
  const { data, isError } = useQuery({ ...searchQueries.filters(viewer), enabled: viewer.ready });
  const filtered =
    params.language !== undefined ||
    params.interviewee !== undefined ||
    params.from !== undefined ||
    params.to !== undefined;

  const apply = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (name: string) => {
      const value = form.get(name);
      return typeof value === "string" && value ? value : undefined;
    };
    const interviewee = text("interviewee");
    const from = text("from");
    const to = text("to");
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
    <Stack component="form" spacing={2.5} onSubmit={apply} aria-label="Filter results">
      <Typography variant="subtitle1" component="h2" sx={{ fontWeight: 600 }}>
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
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          Recording date
        </Typography>
        <TextField
          name="from"
          type="date"
          label="From"
          defaultValue={params.from ?? ""}
          slotProps={{ inputLabel: { shrink: true } }}
        />
        <TextField
          name="to"
          type="date"
          label="To"
          defaultValue={params.to ?? ""}
          slotProps={{ inputLabel: { shrink: true } }}
        />
        <FormControlLabel
          control={<Checkbox name="undated" defaultChecked={params.undated ?? false} />}
          label="Also show undated interviews"
          slotProps={{ typography: { variant: "body2" } }}
        />
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
  );
}

function Results({ params }: { params: SearchParams }) {
  const { viewer } = useAuth();
  const { data, isPending, isError, hasNextPage, fetchNextPage, isFetchingNextPage } =
    useInfiniteQuery({ ...searchQueries.moments(viewer, params), enabled: viewer.ready });

  if (isError)
    return <Alert severity="error">Search isn&apos;t working right now. Please try again.</Alert>;
  if (isPending) return <Skeleton variant="rounded" height={400} />;

  const moments = data.pages.flatMap((page) => page.items);
  const keywordOnly = data.pages.some((page) => page.search_mode === "keyword_only");
  return (
    <Stack spacing={2.5} component="section" aria-label="Search results">
      <Box>
        <Typography variant="subtitle1" component="h2" sx={{ fontWeight: 600 }}>
          Relevant transcript moments
        </Typography>
        <Typography variant="body2" color="text.secondary">
          English translations shown when available · Results are ranked by relevance.
        </Typography>
      </Box>
      {keywordOnly ? (
        <Alert severity="info">
          Searching by meaning isn&apos;t available right now, so these results only match your
          words.
        </Alert>
      ) : null}
      {moments.length === 0 ? (
        <Typography color="text.secondary">
          No moments matched. Try different words, a question, or fewer filters.
        </Typography>
      ) : (
        <>
          {moments.map((moment) => (
            <MomentCard key={`${moment.interview.id}:${String(moment.start_ms)}`} moment={moment} />
          ))}
          {hasNextPage ? (
            <Button
              variant="outlined"
              disabled={isFetchingNextPage}
              onClick={() => void fetchNextPage()}
              sx={{ alignSelf: "center" }}
            >
              {isFetchingNextPage ? "Loading…" : "Show more moments"}
            </Button>
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
