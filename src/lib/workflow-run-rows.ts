/**
 * A session's workflow runs as ordered rows for the phase bar to stack.
 *
 * The runs were always being fetched: `useWorkflowRuns` returns every run a
 * session has, and `client-session-component.tsx` read `data[0]` and dropped
 * the rest. So this is a projection of data already on the client, not a new
 * fetch.
 *
 * Three things here are decisions rather than mechanics, and each is the kind
 * that a later reader would otherwise "fix" back:
 *
 * 1. **Oldest first.** `listWorkflowRuns` returns newest-first and its
 *    docblock calls that "the order the panel renders them in" — true of the
 *    workflow panel, wrong here. This bar sits under the transcript, which
 *    reads top-to-bottom, so the stack is reversed to match: the oldest run
 *    at the top, the live one always last. That also means a new run appends
 *    below rather than displacing the rows above it.
 *
 * 2. **A phaseless run still gets a row.** `deriveWorkflowPhaseProgress`
 *    returns `null` for a run with 0 or 1 phases, because a progress bar
 *    through one phase shows no progress. Skipping it here would make the
 *    stack a misleading list — a session with three runs showing two rows —
 *    so such a run falls back to one whole-run segment
 *    (`deriveWholeRunSegment`). Every run in, every run out.
 *
 * 3. **No cap.** Every run renders. A long session's bar grows, which is
 *    honest; a cap would silently hide history directly above the prompt
 *    input, and a "+N earlier" line would need somewhere to expand to that
 *    this component does not have.
 *
 * The live snapshot is merged in by id rather than appended: while a run is in
 * flight the SSE snapshot is fresher than the list from the API poll, but it
 * describes a run the list already contains. Appending it would render that
 * run twice.
 */

import {
  deriveWholeRunSegment,
  deriveWorkflowPhaseProgress,
  type WorkflowPhaseSegment,
} from "@/lib/workflow-phase-progress";
import type { WorkflowAgentSnapshot, WorkflowSnapshot } from "@/types/workflow";

/** One run's row in the stack. */
export type WorkflowRunRow = {
  /**
   * Stable React key. The run id where there is one; otherwise the run's
   * position, since a snapshot with no `runId` cannot be told from another
   * except by where it came in the list.
   */
  key: string;
  /** Run id, when known — absent on a synthetic or pre-index snapshot. */
  runId?: string;
  /** The workflow's name, shown as the row label. */
  name: string;
  /** Phase segments, or a single whole-run segment for a phaseless run. */
  segments: WorkflowPhaseSegment[];
  /**
   * What this run has spent so far, for the row label's tooltip. Absent when
   * neither the run nor any of its agents has reported usage yet.
   *
   * `partial` marks a run that is still going: the figure is a running total,
   * not a final bill, and the tooltip says so rather than presenting an
   * in-flight number as the cost of the run.
   */
  usage?: { cost: number; partial: boolean; tokens: number };
  /**
   * True when `segments` is the whole-run fallback rather than real phases, so
   * the renderer can label the row honestly instead of implying a phase
   * breakdown the run never declared.
   */
  wholeRun: boolean;
};

/**
 * Build the row list, oldest run first.
 *
 * @param runs - Snapshots as the API returned them: newest first, and possibly
 *   containing nulls for runs with neither a file on disk nor a stored
 *   snapshot (see the `WorkflowRun.snapshot` type). Nulls are dropped — a run
 *   with no snapshot has nothing to draw, and inventing an empty row for it
 *   would assert a shape that was never observed.
 * @param live - The in-flight SSE snapshot, when there is one. Replaces the
 *   list's entry for the same `runId` (it is fresher), or is appended as the
 *   newest run when the list does not have it yet — which is the normal case
 *   for the first seconds of a background run, whose DB entry lags the
 *   `workflow-started` event.
 */
export function deriveWorkflowRunRows(
  runs: readonly (WorkflowSnapshot | null | undefined)[] | null | undefined,
  live?: WorkflowSnapshot | null,
): WorkflowRunRow[] {
  const newestFirst: WorkflowSnapshot[] = [];
  let liveMerged = false;

  for (const snapshot of runs ?? []) {
    if (!snapshot) continue;
    // Prefer the live snapshot for the run it describes; same-run identity is
    // by runId, never by position.
    if (live?.runId && snapshot.runId === live.runId) {
      newestFirst.push(live);
      liveMerged = true;
      continue;
    }
    newestFirst.push(snapshot);
  }

  // A live run the list has not caught up with yet is the newest, so it goes
  // at the head of a newest-first list — and therefore the tail once reversed.
  if (live && !liveMerged) newestFirst.unshift(live);

  // Oldest first: see this module's doc comment.
  return newestFirst
    .slice()
    .reverse()
    .map((snapshot, index) => toRow(snapshot, index));
}

function toRow(snapshot: WorkflowSnapshot, index: number): WorkflowRunRow {
  const phases = deriveWorkflowPhaseProgress(snapshot);

  return {
    key: snapshot.runId ?? `run-${index}`,
    name: snapshot.name,
    runId: snapshot.runId,
    segments: phases ?? [deriveWholeRunSegment(snapshot)],
    usage: runUsage(snapshot),
    wholeRun: phases === null,
  };
}

/**
 * What a run has spent, preferring its own `tokenUsage` over a sum of its
 * agents'.
 *
 * The two agree: a run's `tokenUsage.total` is accumulated from the same
 * per-agent usage the agents report (`recordTokens` in the workflow runtime
 * folds each agent's usage into the run's), and this was checked against a
 * real 8-agent run whose agents summed to its `tokenUsage.total` exactly, to
 * the token and the tenth of a cent. So the fallback is a second route to one
 * number, not a competing estimate.
 *
 * The run's own field is still preferred where present, because it is the one
 * the runtime maintains and it includes spend from RETRIED attempts that never
 * reached a surviving agent record (see `onRetrySpend`) — summing agents would
 * quietly under-count those.
 *
 * Returns undefined rather than a zero when nothing has reported usage, so the
 * renderer can omit the line instead of asserting a run cost nothing.
 */
function runUsage(
  snapshot: WorkflowSnapshot,
): { cost: number; partial: boolean; tokens: number } | undefined {
  // A run is still spending unless it has positively finished. Absence of a
  // terminal signal means "unknown", and a running total is the honest read.
  const partial = !TERMINAL_RUN_STATUSES.has(snapshot.runStatus ?? "");

  if (snapshot.tokenUsage) {
    return {
      cost: snapshot.tokenUsage.cost ?? 0,
      partial,
      tokens: snapshot.tokenUsage.total,
    };
  }

  const summed = snapshot.agents.reduce(
    (total, agent: WorkflowAgentSnapshot) => ({
      cost: total.cost + (agent.cost ?? 0),
      tokens: total.tokens + (agent.tokens ?? 0),
    }),
    { cost: 0, tokens: 0 },
  );

  if (summed.tokens === 0 && summed.cost === 0) return undefined;
  return { ...summed, partial };
}

/**
 * Run-lifecycle statuses after which the spend is final. Mirrors the set in
 * workflow-phase-progress.ts, which is private to that module.
 */
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "aborted"]);
