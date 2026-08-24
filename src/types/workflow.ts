export type WorkflowAgentStatus =
  | "queued"
  | "running"
  | "done"
  | "error"
  | "skipped";

export type WorkflowAgentSnapshot = {
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
