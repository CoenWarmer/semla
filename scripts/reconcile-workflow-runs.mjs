#!/usr/bin/env node
/**
 * Settle workflow runs that are recorded as running but are not.
 *
 * A run's row is finalised by whatever is watching it. When that watcher goes —
 * a killed server, or a continuation aborted by a new prompt — the row stays
 * `running` for good. They accumulate: this repository reached thirteen, the
 * oldest a week and a half old, which makes the sidebar's and the panel's idea
 * of "in flight" useless.
 *
 * The run file on disk is the truth, so each row is settled from it rather than
 * blanket-marked. A file that says completed makes the row completed; one that
 * says failed makes it failed. A row whose file is missing, or still claims to
 * be running long after anything could be working on it, becomes `interrupted`
 * — honest about not knowing how it ended, and no longer claiming it is live.
 *
 * Usage:  npm run workflow:reconcile -- [--dry-run] [--stale-minutes=30]
 *
 * Safe to run more than once, and safe while work is in progress: a row whose
 * file says running and which was touched inside the staleness window is left
 * alone, so a live run is never cut off.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createClient } from "@supabase/supabase-js";

/**
 * The app's own reader, imported rather than mirrored.
 *
 * This script used to derive the run path itself — a sha256 of the resolved
 * cwd under a hardcoded `~/.pi/workflows` — and had fallen behind that
 * derivation on three counts, each of which turned a run it could not find
 * into a row settled on nothing but its age:
 *
 * - `PI_WORKFLOW_HOME` was ignored, so anyone who had moved the workflow home
 *   saw every run reported missing;
 * - the sanitiser kept case and replaced illegal characters one for one, while
 *   `workflowProjectKey` lowercases and collapses runs of them, so any project
 *   directory that is not already lowercase-and-clean hashed to a key nothing
 *   writes to;
 * - it looked only under the key for `PI_WORKSPACE_ROOT`, and runs are keyed by
 *   the cwd the *extension* ran under, which stopped being the workspace root
 *   when sessions gained their own project cwd (session-cwd.ts).
 *
 * `readWorkflowRun` has all three right, searches every project directory on a
 * miss for that last reason, and falls back to a run's `.bak` on a corrupt
 * primary. Node strips the types; the npm script carries the flag that silences
 * the module-type warning importing a `.ts` from a `.mjs` otherwise prints.
 */
import { readWorkflowRun } from "../src/lib/pi/workflow/workflow-run-reader.ts";

const dryRun = process.argv.includes("--dry-run");
const staleArg = process.argv.find((a) => a.startsWith("--stale-minutes="));
const STALE_MINUTES = staleArg ? Number(staleArg.split("=")[1]) : 30;

function loadEnvLocal() {
  const path = join(process.cwd(), ".env.local");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.trim().replace(/^["']|["']$/g, "");
  }
}
loadEnvLocal();

const workspaceRoot = process.env.PI_WORKSPACE_ROOT;
if (!workspaceRoot) {
  console.error("PI_WORKSPACE_ROOT is required: it is where the search for a run file starts.");
  process.exit(1);
}

const readRunFile = (runId) => readWorkflowRun(workspaceRoot, runId);

/**
 * The row status a run file implies.
 *
 * `aborted` is a pi run state but not one this column accepts — the check
 * constraint lists stopped instead — so it is mapped rather than rejected by
 * the database.
 */
const ROW_STATUSES = new Set([
  "completed",
  "failed",
  "paused",
  "stopped",
  "interrupted",
]);

const settledStatus = (file, ageMinutes) => {
  const status = file?.status;
  // Carried across as-is where the column accepts it: a run that genuinely
  // paused is paused, and flattening that to "interrupted" would throw away
  // the one thing the file knew.
  if (status === "aborted") return "stopped";
  if (status && ROW_STATUSES.has(status)) return status;
  // Missing file, or one still claiming to run long after anything could be.
  if (ageMinutes > STALE_MINUTES) return "interrupted";
  return null; // Possibly alive — leave it alone.
};

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const { data: rows, error } = await db
  .from("workflow_runs")
  .select("run_id, semla_session_id, status, updated_at")
  .eq("status", "running")
  .order("updated_at", { ascending: false });

if (error) {
  console.error("Unable to read workflow_runs:", error.message);
  process.exit(1);
}

console.log(`${rows.length} row(s) recorded as running\n`);

const now = Date.now();
let settled = 0;
let left = 0;

for (const row of rows) {
  const ageMinutes = Math.round((now - Date.parse(row.updated_at)) / 60000);
  const file = readRunFile(row.run_id);
  const next = settledStatus(file, ageMinutes);
  const from = file ? `file=${file.status}` : "file=missing";

  if (!next) {
    left += 1;
    console.log(`  keep       ${row.run_id.slice(0, 30).padEnd(32)} ${from}, ${ageMinutes}m — may still be live`);
    continue;
  }

  settled += 1;
  console.log(`  ${(dryRun ? "would set" : "set").padEnd(10)} ${row.run_id.slice(0, 30).padEnd(32)} ${from}, ${ageMinutes}m → ${next}`);

  if (dryRun) continue;

  const { error: updateError } = await db
    .from("workflow_runs")
    .update({ status: next })
    .eq("run_id", row.run_id);

  if (updateError) console.error(`    failed: ${updateError.message}`);
}

// The on-disk index carries the same claim, and it is what a new turn reads to
// decide whether a run is still worth watching. Leaving it behind would mean
// the database is tidy and the app still believes otherwise.
const stateDir = join(process.cwd(), ".semla-state", "runs");
let indexFixed = 0;
if (existsSync(stateDir)) {
  for (const entry of readdirSync(stateDir)) {
    if (!entry.endsWith(".json")) continue;
    const path = join(stateDir, entry);
    let index;
    try {
      index = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }

    let changed = false;
    for (const [runId, record] of Object.entries(index)) {
      if (record?.status !== "running") continue;
      const ageMinutes = Math.round((now - Date.parse(record.updated_at ?? 0)) / 60000);
      const next = settledStatus(readRunFile(runId), ageMinutes);
      if (!next) continue;
      record.status = next;
      changed = true;
      indexFixed += 1;
    }

    if (changed && !dryRun) {
      writeFileSync(path, `${JSON.stringify(index, null, 2)}\n`, "utf8");
    }
  }
}

console.log(
  `\n${dryRun ? "[dry run] " : ""}settled ${settled} row(s), left ${left} alone, ` +
    `${indexFixed} on-disk index entr${indexFixed === 1 ? "y" : "ies"}`,
);
