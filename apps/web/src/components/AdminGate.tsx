import CircularProgress from "@mui/material/CircularProgress";
import Container from "@mui/material/Container";
import { Navigate, Outlet } from "@tanstack/react-router";

import { useAuth } from "../auth/useAuth";

/**
 * Shows admin pages to admins only, and sends everyone else to sign-in, which explains why.
 * Only for the UI: nothing private depends on it, since the API checks every admin request.
 */
export function AdminGate() {
  const { state } = useAuth();
  if (state.status === "loading" || (state.status === "signedIn" && state.role === "checking")) {
    return (
      <Container sx={{ py: 6 }}>
        <CircularProgress aria-label="Checking sign-in" />
      </Container>
    );
  }
  if (state.status !== "signedIn" || state.role !== "admin")
    return <Navigate to="/signin" replace />;
  return <Outlet />;
}
