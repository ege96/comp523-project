import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Container from "@mui/material/Container";
import Divider from "@mui/material/Divider";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { Navigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, useTransition, type SubmitEvent } from "react";

import { SignInError } from "../auth/authClient";
import { useAuth } from "../auth/useAuth";

type Notice = { severity: "error" | "success" | "info"; text: string };

const failureText: Record<SignInError["reason"], string> = {
  badCredentials: "That email and password don't match an account.",
  tooManyAttempts: "Too many attempts. Wait a few minutes, or reset your password.",
  other: "Sign-in didn't complete. Please try again.",
};

export function SignInPage() {
  const auth = useAuth();
  const { state, connect, signOut } = auth;
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<Notice | null>(null);

  // Load Firebase now, so the sign-in popup can open straight from the click.
  useEffect(connect, [connect]);

  if (state.status === "signedIn" && state.role === "admin")
    return <Navigate to="/admin" replace />;

  /** Runs one auth action, showing `done` when it works and the failure when it doesn't. */
  const run = (action: () => Promise<void>, done?: Notice) => {
    setNotice(null);
    startTransition(async () => {
      try {
        await action();
        if (done) setNotice(done);
      } catch (error) {
        setNotice({
          severity: "error",
          text: failureText[error instanceof SignInError ? error.reason : "other"],
        });
      }
    });
  };

  return (
    <Container maxWidth="sm" sx={{ py: 6 }}>
      <Stack spacing={3}>
        <Stack spacing={1}>
          <Typography variant="h1">Admin sign-in</Typography>
          <Typography color="text.secondary">
            Only archive admins sign in. Visitors can search and listen to public interviews without
            an account.
          </Typography>
        </Stack>
        {state.status === "unavailable" ? (
          <Alert severity="warning">Sign-in isn&apos;t available right now.</Alert>
        ) : state.status === "loading" ? (
          <Alert severity="info">Checking sign-in…</Alert>
        ) : state.status === "signedOut" ? (
          <SignInForms pending={pending || !auth.canSignIn} run={run} />
        ) : state.role === "checking" ? (
          <Alert severity="info">Checking your account…</Alert>
        ) : (
          <Stack spacing={2} sx={{ alignItems: "flex-start" }}>
            {state.role === "error" ? (
              <Alert severity="warning">
                Your account couldn&apos;t be checked. Please try again later.
              </Alert>
            ) : state.emailVerified ? (
              <Alert severity="warning">
                {state.email ?? "This account"} isn&apos;t an archive admin. Admins are added by the
                archive&apos;s operator: ask them to add this email, then sign in again.
              </Alert>
            ) : (
              <Alert
                severity="warning"
                action={
                  <Button
                    color="inherit"
                    size="small"
                    disabled={pending}
                    onClick={() => {
                      run(auth.sendEmailVerification, {
                        severity: "success",
                        text: "Verification email sent. Follow its link, then sign out and sign in again.",
                      });
                    }}
                  >
                    Send link
                  </Button>
                }
              >
                Verify {state.email ?? "your email"} before it can be linked to an admin invite.
              </Alert>
            )}
            <Button variant="outlined" onClick={() => void signOut()}>
              Sign out
            </Button>
          </Stack>
        )}
        {notice ? <Alert severity={notice.severity}>{notice.text}</Alert> : null}
      </Stack>
    </Container>
  );
}

function SignInForms({
  pending,
  run,
}: {
  pending: boolean;
  run: (action: () => Promise<void>, done?: Notice) => void;
}) {
  const { signInWithGoogle, signInWithPassword, sendPasswordReset } = useAuth();
  const form = useRef<HTMLFormElement>(null);

  // Uncontrolled, like the search box: the values only matter on submit.
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const text = (name: string) => {
      const value = data.get(name);
      return typeof value === "string" ? value : "";
    };
    const email = text("email").trim();
    const password = text("password");
    run(() => signInWithPassword(email, password));
  };

  const resetPassword = () => {
    const field = form.current?.elements.namedItem("email");
    if (!(field instanceof HTMLInputElement) || !field.reportValidity()) return;
    const email = field.value.trim();
    run(() => sendPasswordReset(email), {
      severity: "info",
      text: `If ${email} has an account, a password reset link is on its way.`,
    });
  };

  return (
    <Stack spacing={3}>
      <Button
        variant="contained"
        disabled={pending}
        onClick={() => {
          run(signInWithGoogle);
        }}
      >
        Sign in with Google
      </Button>
      <Divider>or</Divider>
      <Stack component="form" ref={form} spacing={2} onSubmit={submit}>
        <TextField name="email" type="email" label="Email" autoComplete="username" required />
        <TextField
          name="password"
          type="password"
          label="Password"
          autoComplete="current-password"
          required
        />
        <Stack direction="row" spacing={2} sx={{ justifyContent: "space-between" }}>
          <Button onClick={resetPassword} disabled={pending}>
            Forgot password?
          </Button>
          <Button type="submit" variant="outlined" disabled={pending}>
            Sign in with email
          </Button>
        </Stack>
      </Stack>
    </Stack>
  );
}
