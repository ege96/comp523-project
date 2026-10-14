import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Container from "@mui/material/Container";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { Navigate } from "@tanstack/react-router";
import { useEffect, useState, useTransition, type ReactNode } from "react";

import { useAuth, type AuthState } from "../auth/useAuth";

export function SignInPage() {
  const { state, connect, canSignIn, signIn, signOut } = useAuth();
  const [pending, startTransition] = useTransition();
  const [failed, setFailed] = useState(false);

  // Load Firebase now, so the sign-in popup can open straight from the click.
  useEffect(connect, [connect]);

  if (state.status === "signedIn" && state.role === "admin")
    return <Navigate to="/admin" replace />;

  const startSignIn = () => {
    setFailed(false);
    startTransition(async () => {
      try {
        await signIn();
      } catch {
        setFailed(true);
      }
    });
  };

  return (
    <Container maxWidth="sm" sx={{ py: 6 }}>
      <Stack spacing={2}>
        <Typography variant="h1">Admin sign-in</Typography>
        <Typography color="text.secondary">
          Only archive admins sign in. Visitors can search and listen to public interviews without
          an account.
        </Typography>
        <SignInStatus
          state={state}
          action={
            state.status === "signedIn" ? (
              <Button variant="outlined" onClick={() => void signOut()}>
                Sign out
              </Button>
            ) : (
              <Button variant="contained" disabled={!canSignIn || pending} onClick={startSignIn}>
                Sign in with Google
              </Button>
            )
          }
        />
        {failed ? (
          <Alert severity="error">Sign-in didn&apos;t complete. Please try again.</Alert>
        ) : null}
      </Stack>
    </Container>
  );
}

function SignInStatus({ state, action }: { state: AuthState; action: ReactNode }) {
  switch (state.status) {
    case "unavailable":
      return <Alert severity="warning">Sign-in isn&apos;t available right now.</Alert>;
    case "loading":
      return <Alert severity="info">Checking sign-in…</Alert>;
    case "signedOut":
      return action;
    case "signedIn":
      if (state.role === "checking") return <Alert severity="info">Checking your account…</Alert>;
      return (
        <>
          <Alert severity="warning">
            {state.role === "error"
              ? "Your account couldn't be checked. Please try again later."
              : `${state.email ?? "This account"} isn't an archive admin. Ask an existing admin to add this email, then sign in again.`}
          </Alert>
          {action}
        </>
      );
  }
}
