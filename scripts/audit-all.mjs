#!/usr/bin/env node
/**
 * Audit every dependency tree this repository installs, not just the root one.
 *
 * Semla installs three, and `npm audit` only ever sees the one you run it in.
 * At the time this was written the root tree reported "found 0 vulnerabilities"
 * while the other two held 25 between them, six of them high — including a
 * second, older copy of the pi agent runtime that a wildcard peer dependency had
 * pulled into `.pi/npm`, with an advisory about `auth.json` writes exposing
 * credentials. Nothing in the repository would have told anyone.
 *
 * Extension packages now belong in the root package.json (see the
 * extension-dependency decision in AGENTS.md), so `.pi/npm` should shrink over
 * time. Until it is empty, and for as long as semla-otel keeps its own
 * lockfile, an audit that stops at the root is not an audit.
 *
 * Usage: `npm run audit:all` — or pass a threshold, e.g. `node
 * scripts/audit-all.mjs moderate`. Exits non-zero if any tree is at or above it.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

/** Order matters only for reading: root first, then the trees people forget. */
const TREES = [
  { label: "semla (root)", prefix: "." },
  { label: "pi extensions", prefix: ".pi/npm" },
  { label: "otel package", prefix: ".pi/packages/semla-otel" },
];

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
  console.error("  npm audit --prefix .pi/npm");
  process.exit(1);
}

if (unreadable) process.exit(1);

console.log(`\nNo vulnerabilities at or above "${threshold}" in any tree.`);
