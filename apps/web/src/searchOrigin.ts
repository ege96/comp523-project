import type { AnyRouter, ParsedLocation } from "@tanstack/react-router";

// Which search an open interview came from, keyed by its history entry, so the viewer can
// offer "Back to results" (also after Back/Forward) and a direct visit doesn't.
const origins = new Map<string, ParsedLocation["search"]>();

const entryKey = (location: ParsedLocation) => location.state.__TSR_key;

/** Records, on each navigation, when an interview was opened from the search page. */
export function trackSearchOrigins(router: AnyRouter) {
  return router.subscribe("onBeforeNavigate", ({ fromLocation, toLocation }) => {
    const key = entryKey(toLocation);
    if (!fromLocation || key === undefined || !toLocation.pathname.startsWith("/interviews/")) {
      return;
    }
    const fromKey = entryKey(fromLocation);
    const origin =
      fromLocation.pathname === "/search"
        ? fromLocation.search
        : // The viewer replacing its own URL (?t=) keeps where it came from.
          fromLocation.pathname === toLocation.pathname && fromKey !== undefined
          ? origins.get(fromKey)
          : undefined;
    if (origin) origins.set(key, origin);
  });
}

/** The search params of the results this history entry was opened from, if any. */
export function searchOrigin(location: ParsedLocation) {
  const key = entryKey(location);
  return key === undefined ? undefined : origins.get(key);
}
