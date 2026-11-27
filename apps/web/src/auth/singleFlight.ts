/**
 * Wraps an async function so that calls made while one is still running share its result
 * instead of starting another. Firebase's `getIdToken` refreshes an expired token once per
 * caller, so a page that starts five requests at once would otherwise refresh it five times.
 */
export function singleFlight<T>(run: () => Promise<T>): () => Promise<T> {
  let running: Promise<T> | null = null;
  return () => {
    running ??= run().finally(() => {
      running = null;
    });
    return running;
  };
}
