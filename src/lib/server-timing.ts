/**
 * Minimal `Server-Timing` collector for route handlers.
 *
 * Browser devtools shows a single "total" per request, which hides whether time
 * went to auth, the database, or the filesystem — the difference that decides
 * what is worth optimising. Wrapping each phase here surfaces the breakdown in
 * the Timing tab instead of leaving it to be inferred.
 */
export type ServerTiming = {
  /** `Server-Timing` header value. Empty string when no phase was recorded. */
  header: () => string;
  /** Time `fn`, record it under `name`, and pass its result through. */
  phase: <T>(name: string, fn: () => Promise<T> | T) => Promise<T>;
};

export const createServerTiming = (): ServerTiming => {
  const entries: string[] = [];

  return {
    header: () => entries.join(", "),
    // Recorded in `finally` so a phase that throws still reports the time it
    // burned before failing.
    phase: async <T>(name: string, fn: () => Promise<T> | T): Promise<T> => {
      const start = performance.now();
      try {
        return await fn();
      } finally {
        entries.push(`${name};dur=${(performance.now() - start).toFixed(1)}`);
      }
    },
  };
};
