/**
 * Read pi-dynamic-workflows run files directly from the filesystem without
 * importing the full @quintinshaw/pi-dynamic-workflows package, which pulls in
 * transitive dependencies (@earendil-works/pi-ai) that are not installed.
 *
 * The path logic mirrors workflow-paths.js and run-persistence.js from the
 * pi-dynamic-workflows dist — kept in sync manually.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

export type AgentHistoryEntry = {
  diff?: string;
  isError?: boolean;
  kind: "error" | "text" | "toolCall" | "toolResult";
  path?: string;
  role: "assistant" | "tool" | "user";
  text: string;
  timestamp?: number;
  toolName?: string;
};

export type PersistedAgentState = {
  callId?: string;
  endedAt?: string;
  error?: string;
  history?: AgentHistoryEntry[];
  id: number;
  label: string;
  model?: string;
  phase?: string;
  prompt: string;
  result?: unknown;
  resultPreview?: string;
  startedAt?: string;
  status: "done" | "error" | "queued" | "running" | "skipped";
  tokens?: number;
};

export type PersistedRunState = {
  agents: PersistedAgentState[];
  completedAt?: string;
  currentPhase?: string;
  durationMs?: number;
  phases: string[];
  runId: string;
  startedAt: string;
  status: "aborted" | "completed" | "failed" | "paused" | "pending" | "running";
  tokenUsage?: {
    cacheRead?: number;
    cacheWrite?: number;
    cost?: number;
    input: number;
    output: number;
    total: number;
  };
  updatedAt: string;
  workflowName: string;
};

function sanitize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "project";
}

function workflowRunsDir(cwd: string): string {
  const projectPath = resolve(cwd);
  const slug = sanitize(basename(projectPath) || "project");
  const hash = createHash("sha256").update(projectPath).digest("hex").slice(0, 12);
  const key = `${slug}-${hash}`;
  return join(homedir(), ".pi", "workflows", "projects", key, "runs");
}

export function readWorkflowRun(
  cwd: string,
  runId: string,
): PersistedRunState | null {
  const primary = join(workflowRunsDir(cwd), `${runId}.json`);
  // Also check legacy location (.pi/workflows/runs/ inside cwd)
  const legacy = join(cwd, ".pi", "workflows", "runs", `${runId}.json`);

  for (const path of [primary, legacy]) {
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, "utf8")) as PersistedRunState;
      } catch {
        // corrupt file — try backup
        const backup = `${path}.bak`;
        if (existsSync(backup)) {
          try {
            return JSON.parse(readFileSync(backup, "utf8")) as PersistedRunState;
          } catch {
            /* ignore */
          }
        }
      }
    }
  }
  return null;
}
