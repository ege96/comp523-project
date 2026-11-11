import CssBaseline from "@mui/material/CssBaseline";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import { vi } from "vitest";

import { SignInError, type AuthClient, type AuthUser } from "../auth/authClient";
import { AuthProvider } from "../auth/AuthProvider";
import { createAppRouter } from "../router";

/** A route's body can depend on the request URL (for example its offset). */
type Routes = Record<string, { status?: number; body?: unknown }>;

/** Fake API: answers by path, records the Authorization header of every request. */
export function stubApi(routes: Routes) {
  const calls: { path: string; auth: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string, init?: RequestInit) => {
      const path = input.split("?")[0] ?? input;
      const headers = new Headers(init?.headers);
      calls.push({ path, auth: headers.get("Authorization") });
      const route = routes[path] ?? { status: 404, body: { detail: "Not Found" } };
      const status = route.status ?? 200;
      const body =
        typeof route.body === "function"
          ? (route.body as (u: string) => unknown)(input)
          : route.body;
      return Promise.resolve(
        status === 204 ? new Response(null, { status }) : Response.json(body, { status }),
      );
    }),
  );
  return calls;
}

/**
 * A Firebase stand-in with one account (password "pw"), signed in from the start when
 * `signedIn`. `sent` records the emails it would have sent.
 */
export function fakeAuthClient({
  signedIn,
  emailVerified = true,
}: {
  signedIn: boolean;
  emailVerified?: boolean;
}): AuthClient & { sent: string[] } {
  const user: AuthUser = {
    uid: "u1",
    email: "someone@example.org",
    emailVerified,
    getIdToken: () => Promise.resolve("tok"),
  };
  const sent: string[] = [];
  let listener: ((u: AuthUser | null) => void) | null = null;
  return {
    sent,
    onUserChanged(callback) {
      listener = callback;
      callback(signedIn ? user : null);
      return () => {
        listener = null;
      };
    },
    signInWithGoogle: () => {
      listener?.(user);
      return Promise.resolve();
    },
    signInWithPassword: (email, password) => {
      if (email !== user.email || password !== "pw")
        return Promise.reject(new SignInError("badCredentials"));
      listener?.(user);
      return Promise.resolve();
    },
    sendPasswordReset: (email) => {
      sent.push(`reset:${email}`);
      return Promise.resolve();
    },
    sendEmailVerification: () => {
      sent.push("verify");
      return Promise.resolve();
    },
    signOut: () => {
      listener?.(null);
      return Promise.resolve();
    },
  };
}

export function renderApp(path: string, client: AuthClient | null = null) {
  // Signed-in browsers carry this hint, which makes the provider load the client at once.
  vi.stubGlobal("scrollTo", vi.fn()); // the router restores scroll; jsdom doesn't implement it
  Element.prototype.scrollIntoView = vi.fn(); // nor this (the viewer scrolls to a search hit)
  if (client) localStorage.setItem("swayambhu.auth.v1", "1");
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  render(
    <QueryClientProvider client={queryClient}>
      <CssBaseline />
      <AuthProvider loadClient={() => Promise.resolve(client)}>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>,
  );
  return router;
}
