import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  type RouterHistory,
} from "@tanstack/react-router";
import { z } from "zod";

import { AdminGate } from "./components/AdminGate";
import { AppShell } from "./components/AppShell";
import { HomePage } from "./pages/HomePage";
import { NotFoundPage } from "./pages/NotFoundPage";

// Proposal: URL paths. The handoff names screens (§5), not URLs.
//   /                          home: search box and recently added interviews
//   /search?q=                 search results (transcript moments)
//   /interviews?page=          all interviews, newest first
//   /interviews/$interviewId   interview viewer
//   /signin                    admin sign-in
//   /admin                     upload and review (admins only)
// Only the home page is in the main bundle; the rest load on demand, and `defaultPreload:
// "intent"` fetches a page's code when the pointer rests on a link to it.

const rootRoute = createRootRoute({ component: AppShell, notFoundComponent: NotFoundPage });

const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: HomePage });

const searchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "search",
  validateSearch: z.object({ q: z.string().trim().catch("") }),
  component: lazyRouteComponent(() => import("./pages/SearchPage"), "SearchPage"),
});

const interviewsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "interviews",
  // Page 1 stays out of the URL; anything that isn't a page number falls back to it.
  validateSearch: z.object({ page: z.number().int().min(2).optional().catch(undefined) }),
  component: lazyRouteComponent(() => import("./pages/InterviewsPage"), "InterviewsPage"),
});

const interviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "interviews/$interviewId",
  component: lazyRouteComponent(() => import("./pages/InterviewPage"), "InterviewPage"),
});

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "signin",
  component: lazyRouteComponent(() => import("./pages/SignInPage"), "SignInPage"),
});

// Hiding admin screens is only for the UI: the API checks the token on every admin request.
const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "admin",
  component: AdminGate,
});

const adminHomeRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/",
  component: lazyRouteComponent(() => import("./pages/AdminPage"), "AdminPage"),
});

const routeTree = rootRoute.addChildren([
  homeRoute,
  searchRoute,
  interviewsRoute,
  interviewRoute,
  signInRoute,
  adminRoute.addChildren([adminHomeRoute]),
]);

export function createAppRouter(history?: RouterHistory) {
  return createRouter({
    routeTree,
    history,
    defaultPreload: "intent",
    scrollRestoration: true,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
