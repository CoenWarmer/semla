export type WorkflowAgentStatus =
  | "queued"
  | "running"
  | "done"
  | "error"
  | "skipped";

/** A single turn in an agent's conversation, for timeline visualization. */
export type AgentTurnSnapshot = {
  kind: "prompt" | "toolCall";
  role?: "assistant" | "user";
  text: string;
  timestamp: number;
  toolName?: string;
};

export type WorkflowAgentSnapshot = {
  /** Dollar cost of this agent's own tokens, when the run recorded it. */
  cost?: number;
  endedAt?: string;
  error?: string;
  id: number;
  label: string;
  model?: string;
  phase?: string;
  prompt?: string;
  resultPreview?: string;
  startedAt?: string;
  status: WorkflowAgentStatus;
  tokens?: number;
  /** Per-turn history for Prompts / Tool calls sub-rows. Only present for completed agents. */
  turns?: AgentTurnSnapshot[];
  /**
   * Diagnostic-only context-pressure signals (see
   * docs/plans/subagent-context-pressure.md §4). Never affects `status`
   * above.
   */
  stopReason?: string;
  compactions?: number;
  compactionReasons?: ("manual" | "threshold" | "overflow")[];
};

export type WorkflowSnapshot = {
  agentCount: number;
  agents: WorkflowAgentSnapshot[];
  completedAt?: string;
  currentPhase?: string;
  description?: string;
  doneCount: number;
  errorCount: number;
  name: string;
  phases: string[];
  runId?: string;
  runningCount: number;
  /**
   * The persisted run's own lifecycle status (see `RunStatus` in
   * workflow-run-reader.ts), when this snapshot was built from a run file —
   * i.e. after a page reload with no live in-memory manager for the run. Only
   * set there: while a manager is live, `runningCount`/agent statuses are
   * direct, current evidence and take priority (see
   * workflow-phase-progress.ts), so a live snapshot leaves this undefined
   * rather than duplicating a value that could go stale while still "live".
   * Undefined/absent must never be read as "running" — see
   * `deriveWorkflowPhaseProgress`.
   */
  runStatus?: "pending" | "running" | "paused" | "completed" | "failed" | "aborted";
  startedAt?: string;
  tokenUsage?: {
    cost?: number;
    total: number;
  };
};
