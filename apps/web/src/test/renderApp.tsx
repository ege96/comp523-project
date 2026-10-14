import CssBaseline from "@mui/material/CssBaseline";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import { vi } from "vitest";

import type { AuthClient } from "../auth/authClient";
import { AuthProvider } from "../auth/AuthProvider";
import { createAppRouter } from "../router";

type Routes = Record<string, { status?: number; body: unknown }>;

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
      return Promise.resolve(Response.json(route.body, { status: route.status ?? 200 }));
    }),
  );
  return calls;
}

/** A Firebase stand-in with one account, signed in from the start when `signedIn`. */
export function fakeAuthClient({ signedIn }: { signedIn: boolean }): AuthClient {
  const user = {
    uid: "u1",
    email: "someone@example.org",
    getIdToken: () => Promise.resolve("tok"),
  };
  let listener: ((u: typeof user | null) => void) | null = null;
  return {
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
    signOut: () => {
      listener?.(null);
      return Promise.resolve();
    },
  };
}

export function renderApp(path: string, client: AuthClient | null = null) {
  // Signed-in browsers carry this hint, which makes the provider load the client at once.
  vi.stubGlobal("scrollTo", vi.fn()); // the router restores scroll; jsdom doesn't implement it
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
