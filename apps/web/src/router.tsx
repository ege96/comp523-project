import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  type RouterHistory,
} from "@tanstack/react-router";
import { z } from "zod";

import { QUEUES } from "./admin/workflow";
import { AdminGate } from "./components/AdminGate";
import { AppShell } from "./components/AppShell";
import { HomePage } from "./pages/HomePage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { trackSearchOrigins } from "./searchOrigin";

// Only the home page is in the main bundle; the rest load on demand, and `defaultPreload:
// "intent"` fetches a page's code when the pointer rests on a link to it.

const rootRoute = createRootRoute({ component: AppShell, notFoundComponent: NotFoundPage });

const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: HomePage });

// Filters live in the URL, so a filtered page can be shared and survives a reload.
// A malformed value is dropped rather than failing the page.
const filterSearch = z.object({
  language: z.string().min(1).optional().catch(undefined),
  interviewee: z
    .union([z.number().int(), z.literal("unknown")])
    .optional()
    .catch(undefined),
  from: z.iso.date().optional().catch(undefined),
  to: z.iso.date().optional().catch(undefined),
  undated: z.literal(true).optional().catch(undefined),
  media: z.enum(["audio", "video"]).optional().catch(undefined),
});

const searchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "search",
  validateSearch: filterSearch.extend({ q: z.string().trim().catch("") }),
  component: lazyRouteComponent(() => import("./pages/SearchPage"), "SearchPage"),
});

const interviewsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "interviews",
  // Page 1 stays out of the URL; anything that isn't a page number falls back to it.
  validateSearch: filterSearch.extend({
    page: z.number().int().min(2).optional().catch(undefined),
  }),
  component: lazyRouteComponent(() => import("./pages/InterviewsPage"), "InterviewsPage"),
});

const interviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "interviews/$interviewId",
  validateSearch: z.object({ t: z.number().int().min(0).optional().catch(undefined) }),
  component: lazyRouteComponent(() => import("./pages/InterviewPage"), "InterviewPage"),
});

const aboutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "about",
  component: lazyRouteComponent(() => import("./pages/AboutPage"), "AboutPage"),
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
  validateSearch: z.object({
    view: z.enum(QUEUES).optional().catch(undefined),
    page: z.number().int().min(2).optional().catch(undefined),
  }),
  component: lazyRouteComponent(() => import("./pages/AdminPage"), "AdminPage"),
});

const adminInterviewRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "interviews/$interviewId",
  component: lazyRouteComponent(() => import("./pages/AdminInterviewPage"), "AdminInterviewPage"),
});

const routeTree = rootRoute.addChildren([
  homeRoute,
  searchRoute,
  interviewsRoute,
  interviewRoute,
  aboutRoute,
  signInRoute,
  adminRoute.addChildren([adminHomeRoute, adminInterviewRoute]),
]);

export function createAppRouter(history?: RouterHistory) {
  const router = createRouter({
    routeTree,
    history,
    defaultPreload: "intent",
    scrollRestoration: true,
  });
  // Lets the interview viewer offer "Back to results" when opened from a search.
  trackSearchOrigins(router);
  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
