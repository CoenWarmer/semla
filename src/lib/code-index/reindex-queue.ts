/**
 * Keeping the index current with the code the agent is writing.
 *
 * Semla's agent edits files, so the index goes stale inside the session that is
 * using it: an edit at turn 3 invalidates a citation returned at turn 7. The
 * operator's choice is to reindex on write rather than at the turn boundary, so
 * a search finds code the agent wrote moments earlier.
 *
 * **A write triggers the reindex; it does not wait for it.** `notifyWritten` is
 * synchronous, returns nothing, and cannot throw. Awaiting an embedding
 * round-trip inside the `edit` tool's result hook would put network latency on
 * every file write and would turn a rate limit into a failed edit — the write
 * has already succeeded on disk by then, and nothing about indexing it is worth
 * failing that.
 *
 * Three properties make fire-and-forget safe rather than merely fast:
 *
 *  - **Coalesced and debounced.** An agent rewriting one file five times in a
 *    turn costs one embedding request.
 *  - **Failures never reach the writer.** They are reported through `onError`
 *    and the path is left dirty.
 *  - **The queue is best-effort; it is not the guarantee.** Anything it drops —
 *    a crash, a failed batch, a write during shutdown — is caught by the
 *    session-start fingerprint comparison and by the query-time hash check.
 *    Neither depends on this having worked, which is what makes the queue's
 *    reliability a performance concern rather than a correctness one.
 *
 * That last point is load-bearing and deliberately so: a queue that retried
 * forever to stay correct would be a worse design than one that gives up and
 * lets a cheap, unconditional check find what it missed.
 */

export interface ReindexQueueOptions {
  /**
   * Re-chunk, re-embed and upsert these paths. Injected so the queue is tested
   * without a network, and so the caller decides what "reindex" means for a
   * deletion versus an edit.
   */
  reindex: (paths: string[]) => Promise<void>;
  /**
   * How long to wait after the last write before flushing. Long enough to
   * absorb a burst of edits to one file, short enough that a search later in
   * the same turn sees the result.
   */
  debounceMs?: number;
  /** Reported, never thrown. Paths are left dirty for the next sweep. */
  onError?: (error: unknown, paths: string[]) => void;
}

export interface ReindexQueue {
  /** Record that a path changed. Synchronous, never throws. */
  notifyWritten(path: string): void;
  /** Paths waiting to be indexed, plus any currently being indexed. */
  pending(): string[];
  /** Paths whose last reindex attempt failed. */
  failed(): string[];
  /**
   * Resolve once nothing is queued or in flight.
   *
   * The query path awaits this so a search issued right after a write sees the
   * new content, and tests await it instead of sleeping.
   */
  settled(): Promise<void>;
  /** Flush now rather than waiting out the debounce. */
  flush(): Promise<void>;
  /** Stop the timer and drop what is queued. Used on session shutdown. */
  dispose(): void;
}

export const DEFAULT_DEBOUNCE_MS = 250;

export function createReindexQueue({
  reindex,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  onError,
}: ReindexQueueOptions): ReindexQueue {
  // A Set, so five writes to one path in a turn are one entry and one request.
  const queued = new Set<string>();
  const inFlight = new Set<string>();
  const failedPaths = new Set<string>();

  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let idleWaiters: (() => void)[] = [];

  function resolveIdleIfSettled(): void {
    if (queued.size > 0 || running !== null) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const wake of waiters) wake();
  }

  function scheduleFlush(): void {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, debounceMs);
    // Never hold the process open for an index refresh.
    timer.unref?.();
  }

  async function run(): Promise<void> {
    // One flush at a time. Writes arriving during a flush stay queued and are
    // picked up by the next one, rather than racing this batch's upsert.
    if (running !== null) return running;
    if (queued.size === 0) {
      resolveIdleIfSettled();
      return;
    }

    const batch = [...queued].sort();
    queued.clear();
    for (const path of batch) inFlight.add(path);

    running = (async () => {
      try {
        await reindex(batch);
        for (const path of batch) failedPaths.delete(path);
      } catch (error) {
        // The edit already succeeded. An indexing failure is reported and the
        // paths left dirty for the session-start sweep; it is never raised at
        // whoever wrote the file.
        for (const path of batch) failedPaths.add(path);
        onError?.(error, batch);
      } finally {
        for (const path of batch) inFlight.delete(path);
      }
    })();

    try {
      await running;
    } finally {
      running = null;
    }

    // A write that landed mid-flush is still queued; keep going.
    if (queued.size > 0) await run();
    else resolveIdleIfSettled();
  }

  return {
    notifyWritten(path) {
      queued.add(path);
      scheduleFlush();
    },

    pending() {
      return [...new Set([...queued, ...inFlight])].sort();
    },

    failed() {
      return [...failedPaths].sort();
    },

    settled() {
      if (queued.size === 0 && running === null) return Promise.resolve();
      return new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
      });
    },

    async flush() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      await run();
    },

    dispose() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      queued.clear();
      resolveIdleIfSettled();
    },
  };
}
