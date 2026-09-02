#!/usr/bin/env node
/**
 * Audit every dependency tree this repository installs, not just the root one.
 *
 * `npm audit` only ever sees the tree you run it in. Semla installed three at
 * the time this was written: the root reported "found 0 vulnerabilities" while
 * the other two held 25 between them — six high, including a second, older copy
 * of the pi agent runtime that a wildcard peer dependency had pulled into
 * `.pi/npm`, with an advisory about `auth.json` writes exposing credentials.
 * Nothing in the repository would have told anyone.
 *
 * There is one tree now. Extension packages belong in the root package.json
 * (see the extension-dependency decision in AGENTS.md), and `.pi/` is gone
 * entirely. This survives as the one place a second tree has to be declared, so
 * adding one cannot quietly take its contents out of the audit —
 * `pi-dir-removed.test.ts` is the other half of that.
 *
 * Usage: `npm run audit:all` — or pass a threshold, e.g. `node
 * scripts/audit-all.mjs moderate`. Exits non-zero if any tree is at or above it.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const TREES = [{ label: "semla (root)", prefix: "." }];

const RANK = ["info", "low", "moderate", "high", "critical"];
const threshold = process.argv[2] ?? "high";

if (!RANK.includes(threshold)) {
  console.error(`Unknown level "${threshold}". Expected one of: ${RANK.join(", ")}`);
  process.exit(2);
}

const thresholdIndex = RANK.indexOf(threshold);

/** Severity counts for one tree, or null when it cannot be audited. */
function audit(prefix) {
  const result = spawnSync(
    "npm",
    ["audit", "--json", "--prefix", prefix],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );

  // npm exits non-zero when it finds anything, so stdout is what matters here,
  // not the exit code.
  if (!result.stdout) return null;

  try {
    const report = JSON.parse(result.stdout);
    return report.metadata?.vulnerabilities ?? null;
  } catch {
    return null;
  }
}

let breached = false;
let unreadable = false;

for (const tree of TREES) {
  if (!existsSync(tree.prefix)) {
    console.log(`  ${tree.label.padEnd(16)} not present — skipped`);
    continue;
  }

  const counts = audit(tree.prefix);

  if (!counts) {
    console.log(`  ${tree.label.padEnd(16)} could not be audited`);
    unreadable = true;
    continue;
  }

  const summary =
    RANK.filter((level) => counts[level] > 0)
      .map((level) => `${counts[level]} ${level}`)
      .join(", ") || "clean";

  const overThreshold = RANK.slice(thresholdIndex).some(
    (level) => counts[level] > 0,
  );
  if (overThreshold) breached = true;

  console.log(
    `  ${tree.label.padEnd(16)} ${summary}${overThreshold ? "   <-- at or above " + threshold : ""}`,
  );
}

if (breached) {
  console.error(`\nFound vulnerabilities at or above "${threshold}".`);
  console.error("Audit one tree at a time to see details, e.g.:");
  process.exit(1);
}

if (unreadable) process.exit(1);

console.log(`\nNo vulnerabilities at or above "${threshold}" in any tree.`);
