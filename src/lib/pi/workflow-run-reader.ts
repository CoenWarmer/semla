/**
 * Read workflow run files directly from the filesystem, without going through
 * the WorkflowManager that wrote them — the panel and the API read runs this
 * process never held.
 *
 * The path derivation used to be copied here, "kept in sync manually" with
 * workflow-paths.ts, because dynamic-workflows was an external package whose
 * import pulled in dependencies that were not installed. It is vendored in
 * this tree now, and workflow-paths.ts imports nothing but node builtins and
 * its own constants, so the copy bought nothing and cost the guarantee that a
 * reader and a writer agree on where a run lives.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentHistoryEntry } from "./extensions/dynamic-workflows/src/agent-history.ts";
import {
  workflowProjectPaths,
  workflowProjectsDir,
} from "./extensions/dynamic-workflows/src/workflow-paths.ts";

/**
 * Re-exported, not restated. This file used to declare its own structurally
 * identical copy, for the same reason it carried its own path derivation: the
 * producer lived in a package that could not be imported. A copy like that
 * does not fail to compile when the real type gains a member — it silently
 * stops carrying it, and the errors surface in the consumers rather than here.
 */
export type { AgentHistoryEntry };

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
  /**
   * Diagnostic-only context-pressure signals (see
   * docs/plans/subagent-context-pressure.md §4). Never affects `status`/
   * `error` above.
   */
  stopReason?: string;
  compactions?: number;
  compactionReasons?: ("manual" | "threshold" | "overflow")[];
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
  /** The pi session this run belongs to (undefined on legacy runs). */
  sessionId?: string;
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

function workflowRunsDir(cwd: string): string {
  return workflowProjectPaths(cwd).runsDir;
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
