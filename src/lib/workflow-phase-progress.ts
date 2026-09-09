/**
 * Pure derivation of a workflow's phase-progress segments from a
 * `WorkflowSnapshot`.
 *
 * `WorkflowSnapshot.phases` is just an ordered list of titles — there is no
 * per-phase status field anywhere in the snapshot, because the runtime never
 * emits a "phase completed" fact (see docs/plans and AGENTS.md for why). The
 * only signal available is `currentPhase`, and position in the array
 * relative to it. So status here is derived, not read:
 *
 *   - a phase before `currentPhase` in the array → "done"
 *   - the phase equal to `currentPhase` → "running", but only when there is
 *     positive evidence the run is still live (see `isActivelyRunning`
 *     below) — otherwise "planned"
 *   - a phase after `currentPhase` → "planned"
 *
 * This means a declared phase a branching script skipped is reported "done"
 * once the run has moved past it — there is no way to distinguish "ran" from
 * "skipped" from the snapshot alone, and pretending otherwise would just be a
 * different derivation with the same blind spot. A phase reached at runtime
 * that was never declared up front is not a problem either: `phases` already
 * has it appended (the manager/runtime push it in on first reach), so it is
 * simply one more array entry to position against.
 *
 * `currentPhase` is never cleared once a run finishes (see
 * workflow-manager.ts), so the last-reached phase's index still equals
 * `currentPhase`'s index forever after completion/failure/abort. Reading
 * that equality alone as "running" is the bug: absence of a "the run is
 * over" signal was being treated as evidence the run is still going.
 *
 * The fix reads two kinds of signal, preferring the explicit one:
 *
 *   - `snapshot.runStatus`: the persisted run's own lifecycle status, when
 *     this snapshot was built from disk (post-reload, no live manager for
 *     the run — see workflow-service.ts/workflow-snapshot-merge.ts). One of
 *     "pending" | "running" | "paused" | "completed" | "failed" | "aborted".
 *     "completed"/"failed"/"aborted" are terminal; the rest are not.
 *   - When `runStatus` is absent (a live SSE snapshot straight off the
 *     manager carries no such field — see display.ts's `WorkflowSnapshot`,
 *     which this repo's type deliberately doesn't widen), fall back to
 *     per-agent statuses: terminal only when the run has at least one agent
 *     and every one of them has settled into `done`/`error`/`skipped`. A
 *     zero-agent run or an all-`queued` run is deliberately NOT terminal —
 *     it simply hasn't started any agent work yet.
 *
 * Separately, `isActivelyRunning` is direct, current evidence of live work —
 * `runningCount > 0` or some agent's own `status === "running"` — checked
 * only when the run isn't already known-terminal. No evidence of either →
 * never render "running". This is the "absence of information is not
 * evidence of running" rule the whole module exists to enforce.
 *
 * When the currentPhase index is reached but neither running nor terminal is
 * established (e.g. a paused run, or a snapshot with no agent data at all),
 * the segment renders "planned" — not "running", and not "done" either,
 * since neither is actually known.
 *
 * No React import here on purpose — this module has to stay unit-testable
 * without a DOM, and the component that renders it should be thin.
 */

import type { WorkflowAgentSnapshot, WorkflowSnapshot } from "@/types/workflow";

/** Per-agent statuses after which an agent does no further work. */
const TERMINAL_AGENT_STATUSES = new Set(["done", "error", "skipped"]);

/** Persisted run-lifecycle statuses after which no further agent work happens. */
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "aborted"]);

/**
 * Fallback-only terminality check, used when `snapshot.runStatus` is absent
 * (a live SSE/manager snapshot). A run with no agents yet, or whose agents
 * are all still `queued`, is NOT terminal — it simply hasn't started.
 */
function isRunTerminalByAgents(agents: readonly WorkflowAgentSnapshot[]): boolean {
  if (agents.length === 0) return false;
  return agents.every((agent) => TERMINAL_AGENT_STATUSES.has(agent.status));
}

/**
 * Whether the run itself has finished, preferring the explicit persisted
 * status over the per-agent fallback (see this module's doc comment).
 */
function isRunTerminal(snapshot: WorkflowSnapshot): boolean {
  if (snapshot.runStatus) return TERMINAL_RUN_STATUSES.has(snapshot.runStatus);
  return isRunTerminalByAgents(snapshot.agents);
}

/**
 * Direct evidence that the run is currently doing work, as opposed to merely
 * having a `currentPhase` left over from before it stopped.
 */
function isActivelyRunning(snapshot: WorkflowSnapshot): boolean {
  if (snapshot.runningCount > 0) return true;
  return snapshot.agents.some((agent) => agent.status === "running");
}

export type WorkflowPhaseStatus = "done" | "running" | "planned";

export type WorkflowPhaseSegment = {
  /** The phase's declared or first-reached title. */
  title: string;
  status: WorkflowPhaseStatus;
  /**
   * Agents whose `phase` field matches this title, regardless of their own
   * status — this is "how many agents are or were participating", not "how
   * many are currently running". Zero is a legitimate count, not a sign of
   * missing data.
   */
  agentCount: number;
};

/**
 * Builds the segment list for the phase-progress bar, or `null` when a bar
 * would be noise: no snapshot, no declared/reached phases, or exactly one
 * phase (nothing to show progress *through*).
 */
export function deriveWorkflowPhaseProgress(
  snapshot: WorkflowSnapshot | null | undefined,
): WorkflowPhaseSegment[] | null {
  if (!snapshot) return null;
  const phases = snapshot.phases;
  if (!phases || phases.length <= 1) return null;

  const currentIndex = snapshot.currentPhase
    ? phases.indexOf(snapshot.currentPhase)
    : -1;

  // Positive evidence the run is over, so `currentPhase` — never cleared by
  // the runtime on completion/failure/abort — must not be read as "running".
  const terminal = isRunTerminal(snapshot);
  const running = !terminal && isActivelyRunning(snapshot);

  return phases.map((title, index) => {
    const agentCount = snapshot.agents.filter(
      (agent) => agent.phase === title,
    ).length;

    let status: WorkflowPhaseStatus;
    if (currentIndex === -1) {
      // currentPhase absent or (defensively) not found in phases: nothing is
      // known to be running, so there is nothing to mark "done" ahead of
      // either — every phase is still "planned".
      status = "planned";
    } else if (index < currentIndex) {
      status = "done";
    } else if (index === currentIndex) {
      // Absence of information is not evidence of running: only mark this
      // segment "running" when something on the snapshot actively says so.
      // A terminal run's last-reached phase renders "done" instead — reached
      // but no longer in progress. A phase that was declared but never
      // reached (currentIndex stayed before it, or absent) stays "planned"
      // in either the running or terminal case, per the branches above/below.
      status = running ? "running" : terminal ? "done" : "planned";
    } else {
      status = "planned";
    }

    return { agentCount, status, title };
  });
}

/** Human-readable status label for the tooltip. */
export function phaseStatusLabel(status: WorkflowPhaseStatus): string {
  switch (status) {
    case "done":
      return "Done";
    case "running":
      return "In progress";
    case "planned":
      return "Planned";
  }
}
