/**
 * Mirrors captured artifacts to Postgres without holding a tool call open.
 *
 * Same shape as entry-persist-queue.ts, and deliberately not sharing it: that
 * queue is keyed by `piSessionId` and its ordering guarantee is about
 * `parent_entry_id`, which has no equivalent here — artifacts carry no
 * self-referencing chain, so a second queue with a simpler contract is
 * honester than bending this one's semantics to fit.
 *
 * Keyed by Semla's own session id (not pi's), because that is the id
 * `captureAndRecord`/`captureTurnResidual` already have in scope — see
 * artifact-record.ts — and it is what `session_artifacts.session_id`
 * references.
 *
 * Serial per session for the same reason a serial drain is cheap here too:
 * two overlapping drains would both read `state.pending` and race on
 * clearing it, not because ordering in Postgres matters (the upsert key is
 * `artifact_key`, order-independent).
 */

import { sessionWarn } from "@/lib/pi/session/session-log";
import { persistArtifacts } from "@/lib/pi/artifacts/artifact-persistence";
import type { SessionArtifact } from "@/lib/artifacts/artifact-types";

type QueueState = {
  /** Keys known to be in Postgres, or queued to go there. */
  known: Set<string>;
  pending: SessionArtifact[];
  /** The in-flight drain, so a caller can wait for quiet. */
  draining: Promise<void> | null;
};

const queues = new Map<string, QueueState>();

const stateFor = (sessionId: string): QueueState => {
  const existing = queues.get(sessionId);
  if (existing) return existing;
  const created: QueueState = { draining: null, known: new Set(), pending: [] };
  queues.set(sessionId, created);
  return created;
};

/**
 * Queue whatever in `artifacts` has not already been queued this process.
 *
 * Not awaited by its callers — this only enqueues and, if nothing is
 * draining yet, starts one. `drainArtifacts` is what a caller waits on.
 */
export function queueArtifacts(
  sessionId: string,
  artifacts: readonly SessionArtifact[],
): void {
  const state = stateFor(sessionId);

  // Marked as collected, not afterwards — same reason queueEntries does this:
  // a key repeated inside one call would otherwise reach the same upsert
  // batch twice, which Postgres rejects as affecting one row twice.
  const fresh: SessionArtifact[] = [];
  for (const artifact of artifacts) {
    if (state.known.has(artifact.key)) continue;
    state.known.add(artifact.key);
    fresh.push(artifact);
  }

  if (fresh.length === 0) {
    if (!state.draining && state.pending.length === 0) queues.delete(sessionId);
    return;
  }

  state.pending.push(...fresh);

  if (!state.draining) {
    state.draining = drain(sessionId).finally(() => {
      const current = queues.get(sessionId);
      if (!current) return;
      current.draining = null;
      if (current.pending.length === 0) queues.delete(sessionId);
    });
  }
}

const drain = async (sessionId: string): Promise<void> => {
  for (;;) {
    const state = queues.get(sessionId);
    if (!state || state.pending.length === 0) return;

    const batch = state.pending;
    state.pending = [];

    try {
      await persistArtifacts(sessionId, batch);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The disk JSONL still holds every one of these, so the mirror is
      // behind rather than the record lost. Forgetting the keys lets a later
      // drain in this process try again.
      for (const artifact of batch) state.known.delete(artifact.key);
      sessionWarn(
        sessionId,
        `persisting ${batch.length} artifact(s) failed: ${message}`,
      );
    }
  }
};

/**
 * Wait for a session's artifact queue to go quiet.
 *
 * Called after a turn ends (see the prompt route), detached, so a slow or
 * failing write never costs the turn — it is awaited only so the caller can
 * log completion, not so the response waits on it.
 */
export const drainArtifacts = async (sessionId: string): Promise<void> => {
  for (;;) {
    const draining = queues.get(sessionId)?.draining;
    if (!draining) return;
    await draining;
  }
};

/** Artifacts queued but not yet written, for tests and diagnostics. */
export const pendingArtifactCount = (sessionId: string): number =>
  queues.get(sessionId)?.pending.length ?? 0;
