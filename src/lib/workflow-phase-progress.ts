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

import type {
  WorkflowAgentSnapshot,
  WorkflowAgentStatus,
  WorkflowSnapshot,
} from "@/types/workflow";

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

/**
 * An agent slice's status. Unlike a phase's, this is *read* rather than
 * derived — `WorkflowAgentSnapshot.status` is a fact the runtime records per
 * agent — so it keeps the two outcomes a phase has to collapse into "done":
 * `error` and `skipped`. A phase cannot distinguish them (see this module's
 * doc comment); an agent can, and flattening that here would discard
 * information the snapshot actually has.
 *
 * `queued` maps to "planned" so the vocabulary matches the phase bar's, since
 * both render through the same three visual treatments plus two failure ones.
 */
export type WorkflowAgentSliceStatus =
  | "done"
  | "running"
  | "planned"
  | "error"
  | "skipped";

/** One agent's slice within its phase's segment. */
export type WorkflowPhaseAgentSlice = {
  /** `WorkflowAgentSnapshot.id` — the run's creation order, and the React key. */
  id: number;
  label: string;
  status: WorkflowAgentSliceStatus;
  /** Resolved model id, when the run recorded one. */
  model?: string;
  tokens?: number;
  cost?: number;
};

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
  /**
   * Those same agents as ordered slices, for rendering inside the phase's
   * box. Always `agentCount` long — it is the same set, not a filtered view.
   *
   * IMPORTANT, and the reason this cannot be made to look stable: a workflow
   * script creates agents lazily, so for a phase whose `agent()` calls are
   * sequential (`await`ed one after another) this array GROWS as the run
   * proceeds. The snapshot cannot know the eventual count — the agents do not
   * exist until the preceding `await` returns, and the script is arbitrary
   * JavaScript, so there is nothing to look ahead at. A three-agent
   * sequential phase therefore renders one slice, then two, then three, each
   * re-dividing the same phase box. That is the runtime being honest about
   * what has happened, not a rendering bug, and no derivation here can fix
   * it.
   *
   * Ordered by `id` (creation order) so existing slices keep their position
   * when a new one appears, rather than reshuffling.
   */
  agents: WorkflowPhaseAgentSlice[];
};

/** Maps a recorded agent status onto the slice vocabulary above. */
function agentSliceStatus(status: WorkflowAgentStatus): WorkflowAgentSliceStatus {
  switch (status) {
    case "queued":
      return "planned";
    case "running":
      return "running";
    case "done":
      return "done";
    case "error":
      return "error";
    case "skipped":
      return "skipped";
  }
}

/**
 * The slices for one phase, in creation order.
 *
 * Sorted by `id` rather than trusting `snapshot.agents` order: the snapshot is
 * merged from a live manager and a persisted run file
 * (workflow-snapshot-merge.ts), and only `id` is a stable creation ordinal.
 */
function agentSlicesForPhase(
  agents: readonly WorkflowAgentSnapshot[],
  title: string,
): WorkflowPhaseAgentSlice[] {
  return agents
    .filter((agent) => agent.phase === title)
    .slice()
    .sort((a, b) => a.id - b.id)
    .map(toAgentSlice);
}

/** Projects one agent snapshot onto the fields a slice renders. */
function toAgentSlice(agent: WorkflowAgentSnapshot): WorkflowPhaseAgentSlice {
  return {
    cost: agent.cost,
    id: agent.id,
    label: agent.label,
    model: agent.model,
    status: agentSliceStatus(agent.status),
    tokens: agent.tokens,
  };
}

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
    const agents = agentSlicesForPhase(snapshot.agents, title);
    const agentCount = agents.length;

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

    return { agentCount, agents, status, title };
  });
}

/**
 * A single segment standing in for a whole run, for a run that declared no
 * phases or only one.
 *
 * `deriveWorkflowPhaseProgress` returns `null` for those — there is nothing to
 * show progress *through*, so a phase bar would be noise. But in a stack of
 * runs, omitting the row entirely would leave a silent gap in the session's
 * history, so the caller renders one full-width bar instead, subdivided by the
 * run's agents like any other segment.
 *
 * Status is the run's own, not a phase's: `done` when terminal, `running` on
 * direct evidence of live work, `planned` otherwise — the same
 * "absence of information is not evidence of running" rule this module exists
 * to enforce, minus the array-position reasoning that needs phases to work.
 *
 * The title prefers the one declared phase, falling back to the run's name, so
 * a one-phase run's tooltip still names that phase rather than restating the
 * run label the row already shows.
 */
export function deriveWholeRunSegment(
  snapshot: WorkflowSnapshot,
): WorkflowPhaseSegment {
  const terminal = isRunTerminal(snapshot);
  const running = !terminal && isActivelyRunning(snapshot);

  const agents = snapshot.agents
    .slice()
    .sort((a, b) => a.id - b.id)
    .map(toAgentSlice);

  return {
    agentCount: agents.length,
    agents,
    status: running ? "running" : terminal ? "done" : "planned",
    title: snapshot.phases?.[0] ?? snapshot.name,
  };
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

/**
 * Human-readable status label for an agent slice's tooltip.
 *
 * "Queued" rather than the phase bar's "Planned" for that status: an agent
 * that exists but has not started is genuinely queued, where a phase with no
 * agents yet is only planned.
 */
export function agentSliceStatusLabel(status: WorkflowAgentSliceStatus): string {
  switch (status) {
    case "done":
      return "Done";
    case "running":
      return "In progress";
    case "planned":
      return "Queued";
    case "error":
      return "Failed";
    case "skipped":
      return "Skipped";
  }
}
