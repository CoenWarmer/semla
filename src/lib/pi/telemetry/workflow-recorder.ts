/**
 * Turns the workflow subsystem's lifecycle callbacks into a span tree.
 *
 * The callbacks are already there and already paired: `onPhase` fires once per
 * `phase()`, and `onAgentStart`/`onAgentEnd` fire once per `agent()` call —
 * a cadence `WorkflowManager` itself depends on, and which survives retries
 * (a retried attempt reports through `onRetrySpend`, never a second
 * `onAgentEnd`). Deriving spans from them means **not editing the vendored
 * `agent()` body**, which has retries, worktrees and four exit paths, and where
 * a mispaired span would be a leak rather than a wrong number.
 *
 * Keyed by run id throughout, because runs are concurrent: a background
 * workflow and a foreground one share a manager, and nested `workflow()` calls
 * add more. Nothing here is shared between runs except the sink.
 *
 * See docs/plans/agent-telemetry.md §5 for the tree and §8.4 for why a run
 * nests under the turn that started it.
 */

import {
  WORKFLOW_AGENT_SPAN,
  WORKFLOW_PHASE_SPAN,
  WORKFLOW_RUN_SPAN,
} from "@/lib/pi/telemetry/schema";
import type { OpenSpan, SpanSink } from "@/lib/pi/telemetry/span-sink";

/**
 * "paused" is terminal *for a span*: the run can resume, and a resume starts a
 * new span under the same run id (see `runStarted`). A resumed run therefore
 * reads as two spans, which is what happened.
 */
export type WorkflowRunStatus = "aborted" | "completed" | "failed" | "paused";
export type WorkflowAgentStatus = "aborted" | "done" | "error";

/**
 * What the manager calls. Every method takes the run id, and every one is safe
 * to call for a run that was never started — a manager reloaded mid-run has
 * live agents whose run span belongs to a process that is gone.
 */
export type WorkflowTelemetry = {
  agentEnded: (
    runId: string,
    agent: {
      /** The agent() call id — see `agentStarted`. */
      callId: string;
      cost?: number;
      status: WorkflowAgentStatus;
      totalTokens?: number;
      turns?: number;
    },
  ) => void;
  agentStarted: (
    runId: string,
    agent: {
      /**
       * Unique per agent() call. Concurrent agents routinely share a label, so
       * this is the only safe key — the vendored options say the same thing
       * about their own bookkeeping.
       */
      callId: string;
      /** Position in the run snapshot, which is how the panel identifies it. */
      id?: number;
      label: string;
      model?: string;
      phase?: string;
      prompt?: string;
    },
  ) => void;
  phaseStarted: (runId: string, title: string) => void;
  runEnded: (
    runId: string,
    run: {
      agentCount?: number;
      doneCount?: number;
      errorCount?: number;
      status: WorkflowRunStatus;
    },
  ) => void;
  runStarted: (
    runId: string,
    run: { background: boolean; name: string; parentSpanId?: string | null },
  ) => void;
};

type RunState = {
  /** Keyed by agent() call id, never by label. */
  agents: Map<string, OpenSpan>;
  /** The phase agents currently attach to, if the workflow declared any. */
  phase: OpenSpan | null;
  phaseCount: number;
  /** Agents seen in the current phase, for its end attribute. */
  phaseAgents: number;
  run: OpenSpan;
};

/** A no-op, for a manager constructed without telemetry. */
export const NO_WORKFLOW_TELEMETRY: WorkflowTelemetry = {
  agentEnded: () => {},
  agentStarted: () => {},
  phaseStarted: () => {},
  runEnded: () => {},
  runStarted: () => {},
};

export const createWorkflowTelemetry = (sink: SpanSink): WorkflowTelemetry => {
  const runs = new Map<string, RunState>();

  const closePhase = (state: RunState) => {
    state.phase?.setAttributes({
      "semla.workflow.phase.agent_count": state.phaseAgents,
    });
    state.phase?.close();
    state.phase = null;
    state.phaseAgents = 0;
  };

  return {
    runStarted: (runId, { background, name, parentSpanId }) => {
      // A run id is reused on resume. Close the previous span rather than
      // orphaning it, so a resumed run reads as two spans, which is what
      // happened.
      const existing = runs.get(runId);
      if (existing) {
        closePhase(existing);
        for (const agent of existing.agents.values()) agent.close();
        existing.run.close();
      }

      runs.set(runId, {
        agents: new Map(),
        phase: null,
        phaseAgents: 0,
        phaseCount: 0,
        run: sink.openSpan({
          attributes: {
            "semla.workflow.background": background,
            "semla.workflow.name": name,
            "semla.workflow.run_id": runId,
          },
          name: WORKFLOW_RUN_SPAN,
          parentSpanId,
        }),
      });
    },

    phaseStarted: (runId, title) => {
      const state = runs.get(runId);
      if (!state) return;

      // Phases are sequential, so the previous one ends where this begins.
      closePhase(state);
      state.phase = sink.openSpan({
        attributes: {
          "semla.workflow.phase.index": state.phaseCount,
          "semla.workflow.phase.title": title,
        },
        name: WORKFLOW_PHASE_SPAN,
        parentSpanId: state.run.spanId,
      });
      state.phaseCount += 1;
    },

    agentStarted: (runId, { callId, id, label, model, prompt }) => {
      const state = runs.get(runId);
      if (!state) return;

      state.phaseAgents += 1;
      state.agents.set(
        callId,
        sink.openSpan({
          attributes: {
            "semla.workflow.agent.call_id": callId,
            ...(id === undefined ? {} : { "semla.workflow.agent.id": id }),
            "semla.workflow.agent.label": label,
            ...(model ? { "semla.workflow.agent.model": model } : {}),
            // Sensitive, and kept by default today — the sink decides, from
            // the schema, not this call site (§8.1).
            ...(prompt === undefined
              ? {}
              : { "semla.workflow.agent.prompt": prompt }),
          },
          name: WORKFLOW_AGENT_SPAN,
          // A workflow that never calls phase() puts its agents under the run.
          parentSpanId: state.phase?.spanId ?? state.run.spanId,
        }),
      );
    },

    agentEnded: (runId, { callId, cost, status, totalTokens, turns }) => {
      const span = runs.get(runId)?.agents.get(callId);
      if (!span) return;

      span.setAttributes({
        "semla.workflow.agent.status": status,
        ...(totalTokens === undefined
          ? {}
          : { "semla.workflow.agent.total_tokens": totalTokens }),
        ...(cost === undefined ? {} : { "semla.workflow.agent.cost": cost }),
        ...(turns === undefined ? {} : { "semla.workflow.agent.turns": turns }),
      });
      span.close(
        status === "done"
          ? { status: "ok" }
          : { status: "error", error: { message: status, name: "AgentFailed" } },
      );
      runs.get(runId)?.agents.delete(callId);
    },

    runEnded: (runId, { agentCount, doneCount, errorCount, status }) => {
      const state = runs.get(runId);
      if (!state) return;

      closePhase(state);
      // An agent still open when the run ends was abandoned — an abort, or a
      // crash between its start and end. Closed as an error rather than left
      // open forever, so the trace does not claim it is still running.
      for (const agent of state.agents.values()) {
        agent.close({
          status: "error",
          error: { message: "run ended first", name: "AgentAbandoned" },
        });
      }

      state.run.setAttributes({
        "semla.workflow.status": status,
        ...(agentCount === undefined
          ? {}
          : { "semla.workflow.agent_count": agentCount }),
        ...(doneCount === undefined
          ? {}
          : { "semla.workflow.done_count": doneCount }),
        ...(errorCount === undefined
          ? {}
          : { "semla.workflow.error_count": errorCount }),
      });
      state.run.close(
        status === "completed" || status === "paused"
          ? { status: "ok" }
          : { status: "error", error: { message: status, name: "RunFailed" } },
      );
      runs.delete(runId);
    },
  };
};
