/**
 * What a session's workflow runs cost, from the run files.
 *
 * Disk is authoritative here and the database copy is not: the workflows route
 * has said so for a while — "the DB snapshot is only updated for foreground
 * runs" — and this is what happens when a total ignores it. A real session's
 * one run reported 9,052 tokens in its run file, whose three agents sum to
 * exactly that, against 5,361 in the `workflow_runs` snapshot column, which
 * had been persisted mid-run and never updated. The header read disk and the
 * sidebar read the mirror, so they disagreed by 3,691 tokens — one agent.
 *
 * The index that makes this possible is `workflow-run-index.ts`, which records
 * which runs a session has. Worth stating plainly because the earlier design
 * here was built on the belief that no such index existed: a *run file* has no
 * session id in it, and that was mistaken for disk having no mapping at all.
 */

import { listWorkflowRuns } from "@/lib/pi/workflow-run-index";
import { snapshotFromRunFile } from "@/lib/pi/workflow-service";
import { addUsage, NO_USAGE, type SessionUsage } from "@/lib/session-usage";

type WithUsage = { tokenUsage?: { cost?: number; total?: number } | null };

/**
 * Usage for the runs this session has on disk, and the ids of any whose file
 * is missing.
 *
 * A run with no file is not zero — it may have been written by another machine
 * or pruned — so it is reported rather than silently dropped, and the caller
 * decides whether to ask the backup about it.
 */
export type WorkflowUsageSources = {
  /** Run index directory. Injected so tests never read the real one. */
  dir?: string;
  /** Run file reader. Injected for the same reason. */
  readRun?: (runId: string) => WithUsage | null;
};

export const workflowUsageFromDisk = (
  sessionId: string,
  sources: WorkflowUsageSources = {},
): { indexed: boolean; usage: SessionUsage; withoutFile: string[] } => {
  const readRun =
    sources.readRun ??
    ((runId: string) => snapshotFromRunFile(runId) as WithUsage | null);
  const runs = sources.dir
    ? listWorkflowRuns(sessionId, sources.dir)
    : listWorkflowRuns(sessionId);
  if (runs.length === 0) {
    return { indexed: false, usage: NO_USAGE, withoutFile: [] };
  }

  const withoutFile: string[] = [];
  let usage = NO_USAGE;

  for (const run of runs) {
    const snapshot = readRun(run.run_id);
    if (!snapshot) {
      withoutFile.push(run.run_id);
      continue;
    }

    usage = addUsage(usage, {
      cost: snapshot.tokenUsage?.cost ?? 0,
      tokens: snapshot.tokenUsage?.total ?? 0,
    });
  }

  return { indexed: true, usage, withoutFile };
};
