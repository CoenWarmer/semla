export type WorkflowAgentStatus =
  | "queued"
  | "running"
  | "done"
  | "error"
  | "skipped";

export type WorkflowAgentSnapshot = {
  error?: string;
  id: number;
  label: string;
  model?: string;
  phase?: string;
  resultPreview?: string;
  status: WorkflowAgentStatus;
  tokens?: number;
};

export type WorkflowSnapshot = {
  agentCount: number;
  agents: WorkflowAgentSnapshot[];
  currentPhase?: string;
  doneCount: number;
  errorCount: number;
  name: string;
  phases: string[];
  runId?: string;
  runningCount: number;
  tokenUsage?: {
    cost?: number;
    total: number;
  };
};
