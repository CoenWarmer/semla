/**
 * How a turn reports itself: a consistent log prefix, and the one safe way to
 * start a write nobody waits on.
 */

/**
 * Short prefix for terminal readability — the first 8 characters of the Semla
 * session id, which is enough to follow one session through interleaved output.
 */
export const sessionTag = (semlaSessionId: string): string =>
  `[pi:session:${semlaSessionId.slice(0, 8)}]`;

export const sessionLog = (
  semlaSessionId: string,
  message: string,
  data?: Record<string, unknown>,
): void => {
  const prefix = sessionTag(semlaSessionId);
  if (data) {
    const pairs = Object.entries(data)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(" ");
    console.log(`${prefix} ${message} · ${pairs}`);
  } else {
    console.log(`${prefix} ${message}`);
  }
};

export const sessionWarn = (
  semlaSessionId: string,
  message: string,
): void => {
  console.warn(`${sessionTag(semlaSessionId)} ${message}`);
};

/**
 * Start a persistence write we do not wait on, and absorb its failure.
 *
 * Every one of these is fire-and-forget, and none of them had a catch: a
 * transient Supabase outage — a Cloudflare 522, say — therefore surfaced as an
 * unhandled rejection, which Node terminates the process for by default. A
 * database blip could take the server down mid-turn.
 *
 * Dropping the write is the right outcome for all of them. Snapshots are
 * re-emitted continuously and the workflow panel polls Supabase besides, and a
 * missed title or running-flag update is corrected by the next turn. What is
 * not acceptable is losing it silently, so it is logged.
 *
 * `fire-and-forget-writes.test.ts` asserts that the throwing writes are only
 * ever reached through here.
 */
export const detach = (
  semlaSessionId: string,
  what: string,
  work: Promise<unknown>,
): void => {
  void work.catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    sessionWarn(semlaSessionId, `${what} failed: ${message}`);
  });
};
