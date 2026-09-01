#!/usr/bin/env node
/**
 * One-time backfill of a session's project links on disk.
 *
 * Sessions created before the relation existed carry only `projectPath`, and
 * `sessionProjects()` reconstructs a link from it on every read. That
 * reconstruction is what keeps those sessions showing their project — which
 * means `projectPath` cannot be removed until the links it implies have
 * actually been written down.
 *
 * This writes them, so the fallback becomes dead weight rather than the thing
 * holding fifty-odd sessions together.
 *
 * Usage:  node scripts/backfill-session-projects.mjs [--dry-run]
 *
 * Never touches a record that already has links: disk is authoritative, and a
 * record that has moved on should not be rewritten from a stale mirror. Safe to
 * run more than once.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

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

const workspaceRoot = process.env.PI_WORKSPACE_ROOT;
if (!workspaceRoot) {
  console.error("PI_WORKSPACE_ROOT is required: it is what makes a path relative.");
  process.exit(1);
}

/**
 * The project's path relative to the workspace root, or null if it is outside.
 *
 * Mirrors projectPrefix in src/lib/pi/session-project.ts. Kept as a copy rather
 * than an import because this is a plain .mjs script and that module reaches
 * into the Next alias graph.
 */
function projectPrefix(root, projectPath) {
  if (!projectPath) return null;
  const rel = relative(root, projectPath);
  if (!rel || rel.startsWith("..") || rel.startsWith(sep)) return null;
  return rel.split(sep).join("/");
}

let examined = 0;
let written = 0;
let already = 0;
let outside = 0;

for (const file of readdirSync(sessionDir)) {
  if (!file.endsWith(".json")) continue;
  examined += 1;

  const path = join(sessionDir, file);
  let meta;
  try {
    meta = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    console.warn(`skip  ${file} — unreadable`);
    continue;
  }

  if (Array.isArray(meta.projects) && meta.projects.length > 0) {
    already += 1;
    continue;
  }
  if (!meta.projectPath) continue;

  const relativePath = projectPrefix(workspaceRoot, meta.projectPath);
  if (!relativePath) {
    // Outside the workspace root, so it has no addressable form. Left alone and
    // reported: silently dropping a session's only project would be worse.
    outside += 1;
    console.warn(`skip  ${file} — ${meta.projectPath} is outside ${workspaceRoot}`);
    continue;
  }

  // Dated from the session, not from now: the link is as old as the session,
  // and a provenance record claiming otherwise is worse than no timestamp.
  const at = meta.createdAt ?? new Date().toISOString();
  const next = {
    ...meta,
    projects: [
      {
        path: relativePath,
        origin: "explicit",
        isPrimary: true,
        firstAttachedAt: at,
        lastTouchedAt: at,
      },
    ],
  };

  written += 1;
  console.log(`${dryRun ? "would write" : "write"}  ${file} → ${relativePath}`);
  if (!dryRun) writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

console.log(
  `\n${dryRun ? "[dry run] " : ""}examined ${examined}, wrote ${written}, ` +
    `already linked ${already}, outside the workspace ${outside}`,
);
