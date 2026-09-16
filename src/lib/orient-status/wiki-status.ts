/**
 * Reading and writing `wiki.json`, phase 2's status file.
 *
 * Deliberately the same four-state read as verification-status.ts —
 * never-run / unreadable / orphaned / ok — because a reader has to tell those
 * apart for both phases and none of them is an exception. The duplication is
 * about forty lines and buys two independent schemas; a shared generic over
 * two records with different fields would have to be parameterised by its own
 * validator anyway, which is the part that differs.
 *
 * **Plain write, no read-modify-write and no lock.** One file per phase is what
 * removes the race rather than guarding it: this writer and phase 3's share
 * nothing, so there is no critical section, no stale-lock timeout to tune and
 * no failure mode to test for. See paths.ts.
 *
 * **This module does not run the wiki pipeline.** Phase 2 is driven by the
 * wiki's own tools across many of the `orient` skill's steps, so the skill
 * tells `orient_status` when it finished and this records that it did. A
 * module that tried to drive ingest itself would be re-implementing the half of
 * orient that already works.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { orientStatusPaths } from "./paths";

export interface WikiStatus {
  /** Absolute project root this describes; also detects an orphaned directory. */
  root: string;
  /** ISO 8601. */
  capturedAt: string;
  /** `git rev-parse HEAD` at capture time, or null when there was no HEAD. */
  commitSha: string | null;
  /** Whether the working tree had uncommitted changes at capture. */
  dirty: boolean | null;
}

export type WikiStatusRead =
  | { kind: "ok"; status: WikiStatus; path: string }
  | { kind: "never-run"; path: string }
  | { kind: "unreadable"; path: string; reason: string }
  | { kind: "orphaned"; path: string; recordedRoot: string; expectedRoot: string };

export async function readWikiStatus(projectRoot: string): Promise<WikiStatusRead> {
  const root = resolve(projectRoot);
  const { wiki: path } = orientStatusPaths(root);

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") return { kind: "never-run", path };
    return {
      kind: "unreadable",
      path,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      kind: "unreadable",
      path,
      reason: `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const status = asWikiStatus(parsed);
  if (status === null) {
    return { kind: "unreadable", path, reason: "not a WikiStatus object" };
  }
  if (resolve(status.root) !== root) {
    return { kind: "orphaned", path, expectedRoot: root, recordedRoot: status.root };
  }
  return { kind: "ok", path, status };
}

export interface WriteWikiStatusOptions {
  root: string;
  capturedAt: string;
  commitSha: string | null;
  dirty: boolean | null;
}

export async function writeWikiStatus(
  options: WriteWikiStatusOptions,
): Promise<{ path: string; status: WikiStatus }> {
  const root = resolve(options.root);
  const paths = orientStatusPaths(root);
  await mkdir(paths.dir, { recursive: true });

  const status: WikiStatus = {
    capturedAt: options.capturedAt,
    commitSha: options.commitSha,
    dirty: options.dirty,
    root,
  };
  await writeFile(paths.wiki, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  return { path: paths.wiki, status };
}

export type WikiStaleReason =
  | "never-run"
  | "unreadable"
  | "orphaned"
  /** Captured against a tree with uncommitted changes, which no sha identifies. */
  | "captured-dirty"
  /** HEAD has moved since the capture. */
  | "commit-moved"
  /** Either the capture or the current tree has no readable HEAD. */
  | "no-commit-sha";

export interface WikiStaleness {
  stale: boolean;
  reason: WikiStaleReason | null;
}

/**
 * Whether a recorded wiki capture still describes this tree.
 *
 * `captured-dirty` is checked before the sha comparison on purpose. A capture
 * taken against a dirty tree describes a state the sha does not name, so it
 * cannot be confirmed current even when HEAD has not moved — the working tree
 * it read may have been committed, reverted or edited further since, and
 * nothing recorded here can tell those apart.
 *
 * A missing sha on either side is `no-commit-sha` rather than stale-by-default.
 * It is reported as stale, because a capture that cannot be checked is not a
 * capture you should trust, but the reason distinguishes "this is not a git
 * repository" from "your wiki is out of date", which are different actions.
 */
export function isWikiStale(read: WikiStatusRead, current: {
  commitSha: string | null;
}): WikiStaleness {
  switch (read.kind) {
    case "never-run":
      return { reason: "never-run", stale: true };
    case "unreadable":
      return { reason: "unreadable", stale: true };
    case "orphaned":
      return { reason: "orphaned", stale: true };
    case "ok":
      break;
  }

  if (read.status.dirty === true) return { reason: "captured-dirty", stale: true };
  if (read.status.commitSha === null || current.commitSha === null) {
    return { reason: "no-commit-sha", stale: true };
  }
  if (read.status.commitSha !== current.commitSha) {
    return { reason: "commit-moved", stale: true };
  }
  return { reason: null, stale: false };
}

function asWikiStatus(value: unknown): WikiStatus | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.root !== "string" || typeof record.capturedAt !== "string") {
    return null;
  }
  const commitSha = record.commitSha;
  const dirty = record.dirty;
  // Absent is accepted as null; a wrong *type* is not, because that is a file
  // some other writer produced and its other fields cannot be trusted either.
  if (commitSha !== null && commitSha !== undefined && typeof commitSha !== "string") {
    return null;
  }
  if (dirty !== null && dirty !== undefined && typeof dirty !== "boolean") {
    return null;
  }
  return {
    capturedAt: record.capturedAt,
    commitSha: commitSha ?? null,
    dirty: dirty ?? null,
    root: record.root,
  };
}
