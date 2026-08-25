import type { AgentTurnSnapshot, WorkflowAgentStatus, WorkflowSnapshot } from "@/types/workflow";
import type { AgentHistoryEntry, PersistedAgentState, PersistedRunState } from "./workflow-run-reader";

/** Map persisted agent history entries to lightweight timeline turn snapshots. */
export function historyToTurns(history: AgentHistoryEntry[]): AgentTurnSnapshot[] {
  const result: AgentTurnSnapshot[] = [];
  for (const h of history) {
    if (h.timestamp == null) continue;
    if (h.kind === "text" && (h.role === "user" || h.role === "assistant")) {
      result.push({ kind: "prompt", role: h.role, text: h.text, timestamp: h.timestamp });
    } else if (h.kind === "toolCall") {
      result.push({ kind: "toolCall", text: h.text.slice(0, 60), timestamp: h.timestamp, toolName: h.toolName });
    }
  }
  return result;
}

/** Statuses after which an agent does no further work. */
export const TERMINAL_AGENT_STATUSES = new Set(["done", "error", "skipped"]);

/**
 * The subset of the in-memory WorkflowManager snapshot we consume. It is the
 * only source for agents that are queued or running, and it carries no
 * timestamps at all.
 */
export type LiveSnapshot = {
  agentCount: number;
  agents: Array<{
    error?: string;
    /** Live per-turn history (updated every 250 ms by onAgentHistory). */
    history?: AgentHistoryEntry[];
    id: number;
    label: string;
    model?: string;
    phase?: string;
    prompt?: string;
    result?: unknown;
    resultPreview?: string;
    status: string;
    tokens?: number;
    tokenUsage?: { cost?: number; total?: number };
  }>;
  currentPhase?: string;
  description?: string;
  doneCount: number;
  errorCount: number;
  name: string;
  phases: string[];
  runningCount: number;
  tokenUsage?: { cost?: number; total: number };
};

/**
 * When this process first saw an agent, and first saw it finish. The manager
 * reports no timestamps and the disk file only gains them once an agent
 * completes, so without this a live agent has no start: its bar would either
 * collapse to a point or anchor to the start of the workflow.
 *
 * Keyed by `runId:agentId`, so entries never collide across runs. Process-local
 * and best-effort — after a restart the disk timestamps take over.
 */
type AgentClock = { firstSeenAt: string; terminalAt?: string };
const agentClocks = new Map<string, AgentClock>();

function agentClock(
  runId: string,
  agentId: number,
  status: string,
  now: () => string,
): AgentClock {
  const key = `${runId}:${agentId}`;
  let clock = agentClocks.get(key);
  if (!clock) {
    clock = { firstSeenAt: now() };
    agentClocks.set(key, clock);
  }
  if (!clock.terminalAt && TERMINAL_AGENT_STATUSES.has(status)) {
    clock.terminalAt = now();
  }
  return clock;
}

/**
 * Combine the live manager snapshot with the persisted run file.
 *
 * Membership and status come from the manager (the only place a queued or
 * running agent appears); timing comes from the disk record for the same agent
 * id, falling back to the first-seen clock. Choosing one source instead of
 * merging is what made running bars render with no duration.
 */
export function mergeLiveSnapshot({
  disk,
  live,
  now = () => new Date().toISOString(),
  runId,
}: {
  disk: PersistedRunState | null;
  live: LiveSnapshot;
  now?: () => string;
  runId: string;
}): WorkflowSnapshot {
  const onDisk = new Map<number, PersistedAgentState>(
    (disk?.agents ?? []).map((agent) => [agent.id, agent]),
  );

  const agents = live.agents.map((agent) => {
    const persisted = onDisk.get(agent.id);
    const clock = agentClock(runId, agent.id, agent.status, now);
    return {
      // The manager reports cost once an agent settles; until then the disk
      // record is the only source, so prefer whichever has it.
      cost: agent.tokenUsage?.cost ?? persisted?.tokenUsage?.cost,
      endedAt:
        persisted?.endedAt ??
        (TERMINAL_AGENT_STATUSES.has(agent.status) ? clock.terminalAt : undefined),
      error: agent.error,
      id: agent.id,
      label: agent.label,
      model: agent.model,
      phase: agent.phase,
      prompt: agent.prompt ? agent.prompt.slice(0, 200) : undefined,
      resultPreview:
        typeof agent.result === "string"
          ? agent.result.slice(0, 300)
          : agent.resultPreview,
      startedAt: persisted?.startedAt ?? clock.firstSeenAt,
      status: agent.status as WorkflowAgentStatus,
      tokens: agent.tokens,
      turns: persisted?.history
        ? historyToTurns(persisted.history)
        : agent.history
          ? historyToTurns(agent.history)
          : undefined,
    };
  });

  const earliestStart = agents
    .map((agent) => agent.startedAt)
    .filter((at): at is string => Boolean(at))
    .sort()[0];

  // live.runningCount/doneCount/errorCount are never updated from 0 on the
  // WorkflowManager's managed.snapshot — only the per-agent status fields are
  // mutated. Recompute from the merged agents so polling callers see accurate
  // counts (affects liveMode in the timeline, topbar running count, etc).
  const runningCount = agents.filter((a) => a.status === "running").length;
  const doneCount = agents.filter((a) => a.status === "done").length;
  const errorCount = agents.filter((a) => a.status === "error").length;

  return {
    agentCount: live.agentCount,
    agents,
    completedAt: disk?.completedAt,
    currentPhase: live.currentPhase,
    description: live.description ?? disk?.workflowDescription,
    doneCount,
    errorCount,
    name: live.name,
    phases: live.phases,
    runId,
    runningCount,
    startedAt: disk?.startedAt ?? earliestStart,
    tokenUsage: live.tokenUsage
      ? { cost: live.tokenUsage.cost, total: live.tokenUsage.total }
      : undefined,
  };
}
