#!/usr/bin/env node
/**
 * Backfill: flip an agent stuck "queued"/"running" to "skipped" wherever its
 * run has already settled to a terminal status on disk.
 *
 * Before this repository's WorkflowManager.endRun()/stop() started
 * reconciling agent statuses on a terminal transition (see
 * skipUnfinishedAgents in src/lib/pi/extensions/dynamic-workflows/src/
 * display.ts), a run that ended while an agent was mid-turn left that
 * agent's own status at "queued"/"running" forever — its onAgentEnd never
 * fires once the run around it is gone, and nothing else ever touches it.
 *
 * Every run file already on disk from before that fix carries whatever
 * stale agent statuses it happened to have at the moment its run was
 * aborted/failed/completed. Semla's countSessionAgents sums
 * agent.status === "running" across every run a session has ever had with
 * no cross-check against the run's own status, so a session with one of
 * these files shows a permanently-live agent in its bottom-bar button no
 * matter how long ago the run actually ended.
 *
 * This walks every run file under every project's runs directory once, fixing
 * exactly that mismatch. Idempotent: a run with no unfinished agent left is
 * untouched, so running this again after it has already run finds nothing to
 * do.
 *
 * Usage: npm run workflow:backfill-agents -- [--dry-run]
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The three things this script has to agree with the app about — where the
 * projects live, which run statuses are terminal, and what "unfinished" means
 * for an agent — are imported rather than restated.
 *
 * All three used to be copies, two of them labelled as mirrors, and the paths
 * copy had already drifted: it hardcoded `~/.pi/workflows` and so ignored
 * `PI_WORKFLOW_HOME`, which meant a moved workflow home turned this script
 * into a no-op that reported success. `skipUnfinishedAgents` is the same
 * function the manager runs on a terminal transition, which is the fix this
 * backfills for runs written before it existed.
 *
 * Node strips the types; the npm script carries the flag that silences the
 * module-type warning importing a `.ts` from a `.mjs` otherwise prints.
 */
import { skipUnfinishedAgents } from "../src/lib/pi/extensions/dynamic-workflows/src/display.ts";
import { workflowProjectsDir } from "../src/lib/pi/extensions/dynamic-workflows/src/workflow-paths.ts";
import { TERMINAL_RUN_STATUSES } from "../src/lib/pi/workflow/workflow-run-reader.ts";

const dryRun = process.argv.includes("--dry-run");

const projectsRoot = workflowProjectsDir();

if (!existsSync(projectsRoot)) {
  console.log(`No workflow runs directory at ${projectsRoot}; nothing to do.`);
  process.exit(0);
}

let scanned = 0;
let runsFixed = 0;
let agentsFixed = 0;

for (const projectDir of readdirSync(projectsRoot)) {
  const runsDir = join(projectsRoot, projectDir, "runs");
  if (!existsSync(runsDir)) continue;

  for (const entry of readdirSync(runsDir)) {
    // Same filter as listJsonFilesSafe: excludes .lock, .bak and .tmp files.
    if (!entry.endsWith(".json")) continue;
    const path = join(runsDir, entry);
    scanned += 1;

    let run;
    try {
      run = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue; // Corrupt primary; not this script's job to recover it.
    }

    if (!TERMINAL_RUN_STATUSES.has(run.status) || !Array.isArray(run.agents)) continue;

    // Unchanged agents come back by identity, so the count is a comparison
    // rather than a second copy of the predicate.
    const agents = skipUnfinishedAgents(run.agents);
    const changed = agents.filter((agent, i) => agent !== run.agents[i]).length;
    agentsFixed += changed;

    if (changed === 0) continue;
    runsFixed += 1;

    console.log(`${dryRun ? "would fix" : "fixed"}  ${run.runId ?? entry}  (status=${run.status})`);
    if (dryRun) continue;

    // Same shape writeJsonAtomicWithBackup produces, so a later read (which
    // falls back to .bak on a corrupt primary) can't resurrect the bug this
    // just fixed by reading a stale backup.
    const json = JSON.stringify({ ...run, agents }, null, 2);
    writeFileSync(path, json);
    const bakPath = `${path}.bak`;
    if (existsSync(bakPath)) writeFileSync(bakPath, json);
  }
}

console.log();
console.log(
  `${dryRun ? "[dry run] " : ""}scanned ${scanned} run file(s), fixed ${runsFixed} run(s), ${agentsFixed} agent(s)`,
);
