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
};

export type WorkflowSnapshot = {
  agentCount: number;
  agents: WorkflowAgentSnapshot[];
  completedAt?: string;
  currentPhase?: string;
  doneCount: number;
  errorCount: number;
  name: string;
  phases: string[];
  runId?: string;
  runningCount: number;
  startedAt?: string;
  tokenUsage?: {
    cost?: number;
    total: number;
  };
};
