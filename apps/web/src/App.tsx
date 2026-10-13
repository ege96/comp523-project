import { Alert, Container, Typography } from "@mui/material";
import { useEffect, useState } from "react";

import { fetchReadiness, type ReadinessStatus } from "./api";

type State =
  { kind: "loading" } | { kind: "loaded"; readiness: ReadinessStatus } | { kind: "error" };

export function App({
  loadReadiness = fetchReadiness,
}: {
  loadReadiness?: () => Promise<ReadinessStatus>;
}) {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    loadReadiness()
      .then((readiness) => {
        if (!cancelled) setState({ kind: "loaded", readiness });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [loadReadiness]);

  return (
    <Container maxWidth="sm" sx={{ py: 6 }}>
      <Typography variant="h4" component="h1" gutterBottom>
        Swayambhu Stories
      </Typography>
      {state.kind === "loading" && <Alert severity="info">Checking the API…</Alert>}
      {state.kind === "error" && <Alert severity="error">The API could not be reached.</Alert>}
      {state.kind === "loaded" &&
        (state.readiness.status === "ok" ? (
          <Alert severity="success">API, database, and pgvector are ready.</Alert>
        ) : (
          <Alert severity="warning">
            API is up, but{" "}
            {state.readiness.database ? "pgvector is missing" : "the database is unreachable"}.
          </Alert>
        ))}
    </Container>
  );
}
