/**
 * Which workflow runs belong to a session, on disk.
 *
 * The heavy part of a run — the snapshot with every agent and turn — is already
 * on disk: pi-dynamic-workflows writes a run file, and the workflows route
 * prefers it because the database copy is only kept current for foreground
 * runs. What Postgres still owned was the *index*: which runs a session has and
 * their status, mode and timestamps. Without it a session's panel is empty even
 * though every run file is sitting there.
 *
 * So this stores the index and not the snapshots. It is a few hundred bytes per
 * session, which is what makes it safe to rewrite on every snapshot event —
 * roughly ten a second during a fan-out — where duplicating the snapshots would
 * have meant megabytes a second and a throttle to reason about.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SEMLA_STATE_DIR } from "@/lib/user-settings-store";

export type RunStatus =
  | "running"
  | "completed"
  | "failed"
  | "paused"
  | "stopped"
  | "interrupted";

export interface WorkflowRunRecord {
  run_id: string;
  mode: "foreground" | "background";
  status: RunStatus;
  error: string | null;
  created_at: string;
  updated_at: string;
}

const runsDir = (dir: string) => join(dir, "runs");
const indexPath = (sessionId: string, dir: string) =>
  join(runsDir(dir), `${sessionId}.json`);

/** A session's runs, newest first — the order the panel renders them in. */
export function listWorkflowRuns(
  sessionId: string,
  dir = SEMLA_STATE_DIR,
): WorkflowRunRecord[] {
  try {
    const parsed = JSON.parse(
      readFileSync(indexPath(sessionId, dir), "utf8"),
    ) as Record<string, WorkflowRunRecord>;
    return Object.values(parsed).sort((a, b) =>
      (b.updated_at ?? "").localeCompare(a.updated_at ?? ""),
    );
  } catch {
    return [];
  }
}

/**
 * Record a run, merging into whatever is already known about it.
 *
 * `created_at` is kept from the first write: a run's start does not change, and
 * snapshots arrive continuously after it.
 */
export function upsertWorkflowRun(
  sessionId: string,
  runId: string,
  patch: Partial<Omit<WorkflowRunRecord, "run_id">>,
  dir = SEMLA_STATE_DIR,
): WorkflowRunRecord {
  mkdirSync(runsDir(dir), { recursive: true });

  let index: Record<string, WorkflowRunRecord> = {};
  try {
    index = JSON.parse(readFileSync(indexPath(sessionId, dir), "utf8")) as Record<
      string,
      WorkflowRunRecord
    >;
  } catch {
    // First run of this session.
  }

  const now = new Date().toISOString();
  const existing = index[runId];
  const next: WorkflowRunRecord = {
    run_id: runId,
    mode: existing?.mode ?? "foreground",
    status: existing?.status ?? "running",
    error: existing?.error ?? null,
    created_at: existing?.created_at ?? now,
    ...patch,
    updated_at: now,
  };

  index[runId] = next;
  writeFileSync(indexPath(sessionId, dir), `${JSON.stringify(index, null, 2)}\n`, "utf8");
  return next;
}

/** Runs still marked running, which a new turn has to reconcile. */
export function listRunningWorkflowRuns(
  sessionId: string,
  dir = SEMLA_STATE_DIR,
): WorkflowRunRecord[] {
  return listWorkflowRuns(sessionId, dir).filter((run) => run.status === "running");
}
