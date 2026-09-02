/**
 * Read pi-dynamic-workflows run files directly from the filesystem without
 * importing the full @quintinshaw/pi-dynamic-workflows package, which pulls in
 * transitive dependencies (@earendil-works/pi-ai) that are not installed.
 *
 * The path logic mirrors workflow-paths.ts and run-persistence.ts from the
 * pi-dynamic-workflows dist — kept in sync manually.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

function workflowProjectsDir(): string {
  return join(homedir(), ".pi", "workflows", "projects");
}

function workflowRunsDir(cwd: string): string {
  const projectPath = resolve(cwd);
  const slug = sanitize(basename(projectPath) || "project");
  const hash = createHash("sha256")
    .update(projectPath)
    .digest("hex")
    .slice(0, 12);
  const key = `${slug}-${hash}`;
  return join(workflowProjectsDir(), key, "runs");
}

/**
 * Every path a run could be at, cheapest first.
 *
 * The project key is a hash of the cwd the *extension* ran under, and this
 * module can only guess at that: the caller's idea of the cwd and the agent's
 * have to agree exactly or the lookup misses silently — a background workflow
 * that runs to completion while the panel shows nothing and the watchdog never
 * fires. They diverged the moment sessions stopped running at the workspace
 * root (see session-cwd.ts), and a run written before that change is keyed
 * under the old cwd for its whole life.
 *
 * So the keyed path is a fast path, not the answer. On a miss every project
 * directory is searched, which is a readdir of a directory holding one entry
 * per project ever worked in. That is cheap, and it is the difference between
 * "wrong cwd" being a silent stall and being invisible.
 */
function runFileCandidates(cwd: string, runId: string): string[] {
  const keyed = workflowRunsDir(cwd);
  const candidates = [
    join(keyed, `${runId}.tson`),
    join(keyed, `${runId}.json`),
    // Legacy location: .pi/workflows/runs/ inside the cwd itself.
    join(cwd, ".pi", "workflows", "runs", `${runId}.tson`),
    join(cwd, ".pi", "workflows", "runs", `${runId}.json`),
  ];

  if (candidates.some((path) => existsSync(path))) return candidates;

  let keys: string[];
  try {
    keys = readdirSync(workflowProjectsDir());
  } catch {
    return candidates;
  }

  for (const key of keys) {
    const runs = join(workflowProjectsDir(), key, "runs");
    candidates.push(join(runs, `${runId}.tson`), join(runs, `${runId}.json`));
  }
  return candidates;
}

/** Canonical on-disk path of a run's persisted state, for pointing the model
 *  (or a human) at the full result of a run we only summarise. */
/**
 * Run states after which no further agent work happens.
 *
 * Shared rather than redeclared: a turn deciding whether to keep watching a run
 * and a recovery path deciding whether to deliver its result must agree on what
 * "finished" means, and two copies of this set would drift into a workflow that
 * one half thinks is over and the other is still waiting on.
 */
export const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  "aborted",
  "completed",
  "failed",
]);

export const isRunTerminal = (
  run: PersistedRunState | null,
): run is PersistedRunState =>
  run !== null && TERMINAL_RUN_STATUSES.has(run.status);

export function workflowRunPath(cwd: string, runId: string): string {
  const found = runFileCandidates(cwd, runId).find((path) => existsSync(path));
  // Nothing on disk yet: name the path it will be written to, which is what
  // the message pointing a reader at it wants to say.
  return found ?? join(workflowRunsDir(cwd), `${runId}.tson`);
}

export function readWorkflowRun(
  cwd: string,
  runId: string,
): PersistedRunState | null {
  for (const path of runFileCandidates(cwd, runId)) {
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
