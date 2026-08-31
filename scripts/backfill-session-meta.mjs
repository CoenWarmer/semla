#!/usr/bin/env node
/**
 * One-time backfill of session metadata records.
 *
 * Session metadata now lives in <PI_SESSION_DIR>/<id>.json beside the
 * transcript, but sessions created before that only exist as rows in Postgres.
 * Until they have a record they are invisible to the disk-first paths and the
 * sidebar falls back to the database for them — fine while it is reachable,
 * useless when it is not.
 *
 * Usage:  node scripts/backfill-session-meta.mjs [--dry-run]
 *
 * Never overwrites an existing record: disk is authoritative, and a row that
 * has drifted from it should not win. Safe to run more than once.
 */

import { createClient } from "@supabase/supabase-js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dryRun = process.argv.includes("--dry-run");
const sessionDir = process.env.PI_SESSION_DIR ?? join(process.cwd(), ".semla-sessions");

/** Next loads .env.local for the app; a standalone script has to do it itself. */
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

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. " +
      "Set them in .env.local or the environment.",
  );
  process.exit(1);
}

const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false },
});

const { data: rows, error } = await supabase
  .from("sessions")
  .select("id, title, goal, is_running, project_path, created_at, user_id")
  .order("created_at", { ascending: false });

if (error) {
  console.error(`Unable to read sessions: ${error.message}`);
  process.exit(1);
}

mkdirSync(sessionDir, { recursive: true });

let written = 0;
let skipped = 0;

for (const row of rows ?? []) {
  const path = join(sessionDir, `${row.id}.json`);
  if (existsSync(path)) {
    skipped += 1;
    continue;
  }

  // Shape mirrors SessionMeta in src/lib/pi/session-meta.ts.
  const meta = {
    id: row.id,
    title: row.title ?? null,
    goal: row.goal ?? null,
    projectPath: row.project_path ?? null,
    // Never carry a stale running flag across: whatever was running when the
    // row was last written is certainly not running now.
    isRunning: false,
    createdAt: row.created_at ?? new Date().toISOString(),
    userId: row.user_id ?? null,
  };

  if (!dryRun) writeFileSync(path, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  written += 1;
}

const verb = dryRun ? "would write" : "wrote";
console.log(`sessions in database : ${rows?.length ?? 0}`);
console.log(`${verb} records        : ${written}`);
console.log(`already had a record : ${skipped}`);
console.log(`session directory    : ${sessionDir}`);
