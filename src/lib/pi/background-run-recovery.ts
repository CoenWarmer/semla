/**
 * Finding a background workflow a session has left in flight.
 *
 * A turn that starts a background workflow arms a continuation to watch it. Any
 * *later* prompt aborts that continuation — deliberately, because pi re-targets
 * delivery to the newest session — but if the new turn starts no workflow of
 * its own, nothing arms a replacement. The run then keeps going with nothing
 * watching it: no snapshots persisted, so the panel freezes on whatever it last
 * saw; no running flag, so the UI reads as idle; and no watchdog, so a finished
 * run is not delivered until the user happens to prompt again.
 *
 * Simply chatting — "how's it going?" — is enough to cause it, which is the
 * worst possible trigger, because that is exactly what someone does while
 * waiting for a workflow.
 *
 * So a turn ending needs to ask whether the *session* still has work in flight,
 * not just whether this turn started some.
 */

import {
  listRunningWorkflowRuns,
  type WorkflowRunRecord,
} from "@/lib/pi/workflow-run-index";
import { isRunTerminal, readWorkflowRun } from "@/lib/pi/workflow-run-reader";

/**
 * A background run this session has going, or undefined.
 *
 * The index alone is not enough to answer this. It is written from snapshot
 * events, so a run whose watcher died stays marked `running` in it forever —
 * this repository has entries a week and a half old. Trusting it would arm a
 * continuation for every one of those, each waiting out its thirty-minute
 * timeout for a result that arrived long ago.
 *
 * The run file settles it, so a run is only picked up when the index says it is
 * running *and* the file agrees it has not finished. A missing file is treated
 * as not recoverable rather than as in flight: a run that never wrote one has
 * nothing for a continuation to watch or deliver.
 */
export function unfinishedBackgroundRunId(
  semlaSessionId: string,
  cwd: string,
  options: {
    stateDir?: string;
    listRuns?: (sessionId: string, dir?: string) => WorkflowRunRecord[];
    readRun?: typeof readWorkflowRun;
  } = {},
): string | undefined {
  const {
    listRuns = listRunningWorkflowRuns,
    readRun = readWorkflowRun,
    stateDir,
  } = options;

  for (const run of listRuns(semlaSessionId, stateDir)) {
    if (run.mode !== "background") continue;

    const state = readRun(cwd, run.run_id);
    if (state === null || isRunTerminal(state)) continue;

    return run.run_id;
  }

  return undefined;
}
