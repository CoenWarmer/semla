/**
 * Read pi-dynamic-workflows run files directly from the filesystem without
 * importing the full @quintinshaw/pi-dynamic-workflows package, which pulls in
 * transitive dependencies (@earendil-works/pi-ai) that are not installed.
 *
 * The path logic mirrors workflow-paths.ts and run-persistence.ts from the
 * pi-dynamic-workflows dist — kept in sync manually.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

export type AgentHistoryEntry = {
  diff?: string;
  isError?: boolean;
  kind: "error" | "text" | "thinking" | "toolCall" | "toolResult";
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
  /** Per-agent usage; the only place an agent's own cost is recorded. */
  tokenUsage?: {
    cacheRead?: number;
    cacheWrite?: number;
    cost?: number;
    input?: number;
    output?: number;
    total?: number;
  };
};

export type PersistedRunState = {
  agents: PersistedAgentState[];
  completedAt?: string;
  currentPhase?: string;
  durationMs?: number;
  /** Everything the script passed to log(), plus the runner's own final entry. */
  logs?: string[];
  phases: string[];
  /** Whatever the workflow script returned. Present once the run completes. */
  result?: unknown;
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
  script?: string;
  workflowDescription?: string;
  workflowName: string;
};

/** Extract the description string from a workflow script's meta literal. */
export function extractWorkflowDescription(
  script: string | undefined,
): string | undefined {
  if (!script) return undefined;
  const m = script.match(/\bdescription\s*:\s*['"`]([^'"`]+)['"`]/);
  return m?.[1];
}

function sanitize(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "project"
  );
}

function workflowRunsDir(cwd: string): string {
  const projectPath = resolve(cwd);
  const slug = sanitize(basename(projectPath) || "project");
  const hash = createHash("sha256")
    .update(projectPath)
    .digest("hex")
    .slice(0, 12);
  const key = `${slug}-${hash}`;
  return join(homedir(), ".pi", "workflows", "projects", key, "runs");
}

/** Canonical on-disk path of a run's persisted state, for pointing the model
 *  (or a human) at the full result of a run we only summarise. */
export function workflowRunPath(cwd: string, runId: string): string {
  const jsonPath = join(workflowRunsDir(cwd), `${runId}.json`);
  if (existsSync(jsonPath)) return jsonPath;
  return join(workflowRunsDir(cwd), `${runId}.tson`);
}

export function readWorkflowRun(
  cwd: string,
  runId: string,
): PersistedRunState | null {
  const primary = join(workflowRunsDir(cwd), `${runId}.tson`);
  const primaryJson = join(workflowRunsDir(cwd), `${runId}.json`);
  // Also check legacy location (.pi/workflows/runs/ inside cwd)
  const legacy = join(cwd, ".pi", "workflows", "runs", `${runId}.tson`);
  const legacyJson = join(cwd, ".pi", "workflows", "runs", `${runId}.json`);

  for (const path of [primary, primaryJson, legacy, legacyJson]) {
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, "utf8")) as PersistedRunState;
      } catch {
        // corrupt file — try backup
        const backup = `${path}.bak`;
        if (existsSync(backup)) {
          try {
            return JSON.parse(
              readFileSync(backup, "utf8"),
            ) as PersistedRunState;
          } catch {
            /* ignore */
          }
        }
      }
    }
  }
  return null;
}
