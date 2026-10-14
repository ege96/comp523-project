import Alert from "@mui/material/Alert";
import Container from "@mui/material/Container";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { getRouteApi } from "@tanstack/react-router";

import { SearchBox } from "../components/SearchBox";

const route = getRouteApi("/search");

/** Placeholder until the search API lands: results will be timestamped transcript moments. */
export function SearchPage() {
  const { q } = route.useSearch();
  return (
    <Container sx={{ py: 6 }}>
      <Stack spacing={3}>
        <Typography variant="h1">Search</Typography>
        {/* key: a new query in the URL resets the uncontrolled field. */}
        <SearchBox key={q} defaultValue={q} />
        <Alert severity="info">
          Transcript search is still being built
          {q ? <>, so there are no results for “{q}” yet</> : null}.
        </Alert>
      </Stack>
    </Container>
  );
}
