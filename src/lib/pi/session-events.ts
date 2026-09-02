/**
 * The events a prompt turn publishes to the client, and the readers that turn
 * raw agent-stream values into them.
 *
 * Shared by the prompt turn, its event router, and the background continuation,
 * all three of which emit or persist the same snapshot shape.
 */

import type { AskUserPayload } from "@/lib/pi/ask-user-bridge";
import type { CodeMap } from "@/lib/code-map/types";
import {
  historyToTurns,
  stampLiveTimestamps,
} from "@/lib/pi/workflow-snapshot-merge";
import type { WorkflowSnapshot } from "@/types/workflow";

export type PiSessionEvent =
  | { text: string; type: "user-message" }
  | { delta: string; type: "assistant-delta" }
  | {
      at: string;
      params?: Record<string, string>;
      summary?: string;
      toolCallId: string;
      toolName: string;
      type: "tool-start";
    }
  | {
      at: string;
      isError: boolean;
      toolCallId: string;
      toolName: string;
      type: "tool-end";
    }
  | { map: CodeMap; type: "code-map" }
  | { runId: string; startedAt: string; type: "workflow-started" }
  | { snapshot: WorkflowSnapshot; type: "workflow-snapshot" }
  | { payload: AskUserPayload; type: "ask-user-question" }
  | { message: string; type: "error" }
  | { title: string; type: "title-updated" }
  | { type: "complete" };

/** Publishes an event to both the SSE stream and the caller's handler. */
export type EmitSessionEvent = (event: PiSessionEvent) => void;

export const asWorkflowSnapshot = (
  value: unknown,
): WorkflowSnapshot | undefined => {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  // Two shapes reach here. A tool result wraps the snapshot in `details`; a
  // snapshot read straight off the manager — which is how a bridge-dispatched
  // ingest reports progress — is already the thing itself. Requiring the
  // wrapper silently dropped every event from those runs.
  const details = "details" in value ? value.details : value;
  if (!details || typeof details !== "object" || !("agents" in details)) {
    return undefined;
  }

  const raw = details as WorkflowSnapshot;

  // The internal snapshot carries history[] on each agent (updated every 250ms
  // by onAgentHistory). Convert it to turns so tool calls appear in the timeline
  // during execution, not only after the agent completes.
  const agents = raw.agents.map((agent) => {
    if (agent.turns) return agent;
    const history = (agent as Record<string, unknown>)["history"];
    if (!Array.isArray(history) || history.length === 0) return agent;
    return {
      ...agent,
      turns: historyToTurns(history as Parameters<typeof historyToTurns>[0]),
    };
  });

  return { ...raw, agents };
};

export const getBackgroundWorkflowRunId = (
  value: unknown,
): string | undefined => {
  if (!value || typeof value !== "object" || !("details" in value)) {
    return undefined;
  }

  const details = value.details;
  if (
    !details ||
    typeof details !== "object" ||
    !("background" in details) ||
    details.background !== true ||
    !("runId" in details) ||
    typeof details.runId !== "string"
  ) {
    return undefined;
  }

  return details.runId;
};

const withRunId = (
  snapshot: WorkflowSnapshot,
  runId: string | undefined,
): WorkflowSnapshot =>
  !snapshot.runId && runId ? { ...snapshot, runId } : snapshot;

/**
 * Resolve a snapshot straight off the agent stream into one the timeline can
 * draw: attach the run id, then stamp the timing the manager never reports.
 * Without the stamp, every agent renders as a full-width bar until the polling
 * snapshot takes over.
 */
export const liveSnapshot = (
  snapshot: WorkflowSnapshot,
  runId: string | undefined,
): WorkflowSnapshot => {
  const withId = withRunId(snapshot, runId);
  return withId.runId ? stampLiveTimestamps(withId.runId, withId) : withId;
};
