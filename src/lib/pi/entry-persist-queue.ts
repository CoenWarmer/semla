/**
 * Mirrors a turn's entries to Postgres without holding the turn open.
 *
 * Two problems, one queue.
 *
 * The turn used to write every entry in the whole conversation, every turn, one
 * round trip at a time, and only then emit `complete` — so the client kept
 * spinning after the answer had finished streaming. A ten-turn session in
 * .semla-debug spent 337 seconds on 3,009 of those writes, 133 of them in its
 * last turn alone, and the cost grew for the rest of the session's life.
 *
 * So: only entries this session has not already stored are written, and they go
 * out in batches, after the turn has told the client it is done.
 *
 * Deferring is safe because Postgres is the mirror here, not the record.
 * `getTranscript` reads the session's own `.jsonl` file and only falls back to
 * the database when that file is missing, and pi has already written the file
 * by the time a turn ends. A reload during the drain therefore shows the
 * complete conversation. What a lost process costs is a mirror that is a turn
 * behind — which `createSessionFile` re-seeds from only in the case where the
 * file is gone too, and that case has already lost the record itself.
 *
 * Serial per pi session: entries carry a self-referencing `parent_entry_id`, so
 * two overlapping drains could present a child before its parent.
 */

import { sessionWarn } from "@/lib/pi/session-log";
import {
  persistEntries,
  type PiSessionEntry,
} from "@/lib/pi/session-persistence";

type QueueState = {
  /** Ids known to be in Postgres, or queued to go there. */
  known: Set<string>;
  pending: PiSessionEntry[];
  /** The in-flight drain, so a caller can wait for quiet. */
  draining: Promise<void> | null;
};

const queues = new Map<string, QueueState>();

const stateFor = (piSessionId: string): QueueState => {
  const existing = queues.get(piSessionId);
  if (existing) return existing;
  const created: QueueState = {
    draining: null,
    known: new Set(),
    pending: [],
  };
  queues.set(piSessionId, created);
  return created;
};

/**
 * Declare the entries Postgres already holds, so they are not written again.
 *
 * Called at the start of a turn with what `fetchPersistedEntries` returned.
 * Additive rather than replacing: a previous turn's drain may still be in
 * flight, and its ids are not in that result yet.
 */
export const seedPersistedEntryIds = (
  piSessionId: string,
  ids: readonly string[],
): void => {
  const state = stateFor(piSessionId);
  for (const id of ids) state.known.add(id);
};

/**
 * Queue whatever in `entries` has not been stored yet. Returns how many that
 * was, which is the number the debug artifact reports.
 *
 * Entries are append-only — every `SessionManager` writer is an `append*`, and
 * compaction adds an entry of its own rather than rewriting one — so having
 * seen an id is enough to know the row is current. Nothing needs to diff
 * payloads.
 */
export const queueEntries = (
  piSessionId: string,
  semlaSessionId: string,
  entries: readonly PiSessionEntry[],
): number => {
  const state = stateFor(piSessionId);

  // Marked as they are collected, not afterwards: an id repeated inside one
  // call would otherwise pass the filter twice and land in the same upsert
  // twice, which Postgres rejects outright — "ON CONFLICT DO UPDATE command
  // cannot affect row a second time" — taking the whole batch with it.
  const fresh: PiSessionEntry[] = [];
  for (const entry of entries) {
    if (state.known.has(entry.id)) continue;
    state.known.add(entry.id);
    fresh.push(entry);
  }

  if (fresh.length === 0) {
    // Nothing to do, and nothing retaining the session's queue.
    if (!state.draining && state.pending.length === 0) {
      queues.delete(piSessionId);
    }
    return 0;
  }

  state.pending.push(...fresh);

  if (!state.draining) {
    state.draining = drain(piSessionId, semlaSessionId).finally(() => {
      const current = queues.get(piSessionId);
      if (!current) return;
      current.draining = null;
      // Keeping `known` for a session with nothing in flight would grow with
      // every session the process ever served. The next turn re-seeds it from
      // the database anyway.
      if (current.pending.length === 0) queues.delete(piSessionId);
    });
  }

  return fresh.length;
};

const drain = async (
  piSessionId: string,
  semlaSessionId: string,
): Promise<void> => {
  for (;;) {
    const state = queues.get(piSessionId);
    if (!state || state.pending.length === 0) return;

    const batch = state.pending;
    state.pending = [];

    try {
      await persistEntries(piSessionId, batch);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The session file still holds every one of these, so the mirror is
      // behind rather than the conversation lost. Forgetting the ids lets a
      // later turn try again.
      for (const entry of batch) state.known.delete(entry.id);
      sessionWarn(
        semlaSessionId,
        `persisting ${batch.length} entries failed: ${message}`,
      );
    }
  }
};

/**
 * Wait for a session's queue to go quiet.
 *
 * For tests, and for a caller that genuinely needs the mirror current before
 * it reads from Postgres rather than from the session file.
 */
export const flushEntryQueue = async (piSessionId: string): Promise<void> => {
  for (;;) {
    const draining = queues.get(piSessionId)?.draining;
    if (!draining) return;
    await draining;
  }
};

/** Entries queued but not yet written, for tests and diagnostics. */
export const pendingEntryCount = (piSessionId: string): number =>
  queues.get(piSessionId)?.pending.length ?? 0;
