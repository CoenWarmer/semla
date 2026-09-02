/**
 * The message pi-dynamic-workflows would have delivered for a finished run.
 *
 * Used by both recovery paths — the in-continuation watchdog and the
 * next-prompt catch-up — so a run whose result pi never delivered still reaches
 * the conversation, worded the same way either way.
 */

import { PI_WORKSPACE_ROOT } from "@/lib/pi/runtime-config";
import { summarizeRunResult } from "@/lib/pi/workflow-result-summary";
import {
  workflowRunPath,
  type PersistedRunState,
} from "@/lib/pi/workflow-run-reader";

export const finishedRunMessage = (
  run: PersistedRunState,
  runId: string,
  /** The cwd the run is keyed under; see session-cwd.ts. */
  cwd: string = PI_WORKSPACE_ROOT,
): string => {
  const done = run.agents.filter((agent) => agent.status === "done").length;
  return [
    `✓ Background workflow "${run.workflowName}" finished (${done}/${run.agents.length} agents).`,
    "",
    summarizeRunResult(run.result, run.logs ?? []),
    "",
    `↳ Full result: ${workflowRunPath(cwd, runId)}`,
  ].join("\n");
};
