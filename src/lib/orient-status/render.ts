/**
 * Rendering an orient status report for the model.
 *
 * Phase by phase, each line carrying the fact that decided it — a status the
 * agent cannot trace back to a sha, a digest or a `head.json` timestamp is one
 * it has to re-derive anyway.
 *
 * Separate from verification-signals/render.ts, which renders the *signals*.
 * This renders the *state of the three phases*, and the tool's report mode
 * prints both.
 */

import type { OrientStalenessReport } from "./staleness";

export function renderOrientStatus(report: OrientStalenessReport): string {
  const lines: string[] = [`Orient status for ${report.root}`, ""];

  lines.push("Phase 1 — code index:");
  const index = report.index.status;
  if (report.index.error !== null) {
    lines.push(`  status could not be read (${report.index.error}).`);
  } else if (index === null || !index.indexed) {
    lines.push(
      '  never indexed. Run `orient_status({ run: "code-index" })` to start a run.',
    );
  } else {
    lines.push(
      `  indexed ${index.updated ?? "at an unrecorded time"} — ${index.chunks ?? 0} chunk(s), model ${index.model ?? "unknown"}.`,
    );
    // Stated rather than left implicit: the report deliberately does not pay
    // for the full tree hash, so it cannot claim the index is current.
    lines.push(
      "  freshness not recomputed — confirming it needs a full tree hash, which " +
        "`code_search` already does per query.",
    );
  }
  if (index?.running === true) lines.push("  a run is in flight right now.");
  if (index?.error != null) lines.push(`  last run failed: ${index.error}`);
  lines.push("");

  lines.push("Phase 2 — wiki orient:");
  const wiki = report.wiki.read;
  if (report.wiki.error !== null) {
    lines.push(`  status could not be read (${report.wiki.error}).`);
  } else if (wiki === null || wiki.kind === "never-run") {
    lines.push("  never recorded. The `orient` skill drives this phase through the wiki tools,");
    lines.push('  then records it with `orient_status({ record: "wiki" })`.');
  } else if (wiki.kind === "unreadable") {
    lines.push(`  the record at ${wiki.path} could not be read (${wiki.reason}).`);
  } else if (wiki.kind === "orphaned") {
    lines.push(
      `  the record at ${wiki.path} describes ${wiki.recordedRoot}, not ${wiki.expectedRoot} — orphaned.`,
    );
  } else {
    const dirtyNote =
      wiki.status.dirty === true
        ? ", against a dirty tree"
        : wiki.status.dirty === false
          ? ", against a clean tree"
          : "";
    lines.push(
      `  recorded ${wiki.status.capturedAt} at ${wiki.status.commitSha ?? "no commit"}${dirtyNote}.`,
    );
    lines.push(
      `  HEAD is now ${report.wiki.currentCommitSha ?? "unreadable"}${
        report.wiki.currentDirty === true ? " (tree dirty)" : ""
      }.`,
    );
    lines.push(
      report.wiki.staleness.stale
        ? `  STALE: ${report.wiki.staleness.reason}.`
        : "  current.",
    );
  }
  lines.push("");

  lines.push("Phase 3 — verification signals:");
  const verification = report.verification.read;
  if (report.verification.error !== null) {
    lines.push(`  status could not be read (${report.verification.error}).`);
  } else if (verification === null || verification.kind === "never-run") {
    lines.push(
      '  never recorded. Pass run: "verification-signals" to record the signals below.',
    );
  } else if (verification.kind === "unreadable") {
    lines.push(
      `  the record at ${verification.path} could not be read (${verification.reason}). Re-run to replace it.`,
    );
  } else if (verification.kind === "orphaned") {
    lines.push(
      `  the record at ${verification.path} describes ${verification.recordedRoot}, not ${verification.expectedRoot} — orphaned.`,
    );
  } else {
    lines.push(
      `  recorded ${verification.status.capturedAt}, ${
        report.verification.stale ? "STALE — an input file has changed since" : "current"
      }.`,
    );
  }

  return lines.join("\n");
}
