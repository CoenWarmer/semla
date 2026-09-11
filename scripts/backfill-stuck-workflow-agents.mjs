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
 * This walks every run file under ~/.pi/workflows/projects/* /runs/ once,
 * fixing exactly that mismatch. Idempotent: a run with no unfinished agent
 * left is untouched, so running this again after it has already run finds
 * nothing to do.
 *
 * Usage: node scripts/backfill-stuck-workflow-agents.mjs [--dry-run]
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dryRun = process.argv.includes("--dry-run");

/** Mirrors IN_MEMORY_TERMINAL_STATUSES / TERMINAL_RUN_STATUSES in the manager. */
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "aborted"]);
const UNFINISHED_AGENT_STATUSES = new Set(["queued", "running"]);

const projectsRoot = join(homedir(), ".pi", "workflows", "projects");

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

    let changed = false;
    const agents = run.agents.map((agent) => {
      if (!UNFINISHED_AGENT_STATUSES.has(agent?.status)) return agent;
      changed = true;
      agentsFixed += 1;
      return { ...agent, status: "skipped" };
    });

    if (!changed) continue;
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
