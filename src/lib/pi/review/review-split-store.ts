/**
 * Where the operator has cut hunks in the review editor, on disk.
 *
 * git cannot hold this. The index records file contents, not how a hunk was
 * sliced, and a cut is a choice about how to stage rather than a change to
 * anything — so until a part is staged there is nothing in the repository to
 * attach it to. Once a part *is* staged git holds the result and the editor
 * draws it from the staged and unstaged diffs; this store is for the cuts in
 * between, which used to vanish on a reload.
 *
 * In `SEMLA_STATE_DIR` per AGENTS.md: it is Semla's own state, not a
 * credential, so it goes in the gitignored in-repo tree. One file per
 * *repository* rather than per session, keyed by a digest of the repository's
 * absolute root: cuts describe that working tree's diff, which every session
 * linked to it sees identically, and a per-session file would show two
 * sessions on one repository two different sets of cuts on the same hunk.
 *
 * Pruned on every write to the keys the file's current diffs still have (see
 * `pruneSplits`), so the store holds what can still be drawn and nothing that
 * a stage, an edit or a commit has since retired.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { splitKey } from "@/lib/review/review-split-key";
import type { FileDiff } from "@/lib/review/review-types";
import { SEMLA_STATE_DIR } from "@/lib/stores/user-settings-store";

/** A file's cuts: boundaries, keyed by `splitKey`. */
export type FileSplits = Record<string, number[]>;

interface RepositorySplits {
  /** The absolute root this file is about — for a human reading the file. */
  root: string;
  /** Keyed by project-relative path. */
  files: Record<string, FileSplits>;
}

const SPLIT_DIR = "review-splits";

const splitsPath = (root: string, dir: string) =>
  join(
    dir,
    SPLIT_DIR,
    `${createHash("sha256").update(root).digest("hex").slice(0, 16)}.json`,
  );

function readRepository(root: string, dir: string): RepositorySplits {
  try {
    const parsed = JSON.parse(readFileSync(splitsPath(root, dir), "utf8")) as RepositorySplits;
    return { files: parsed.files ?? {}, root };
  } catch {
    return { files: {}, root };
  }
}

export function readFileSplits(
  root: string,
  relPath: string,
  dir = SEMLA_STATE_DIR,
): FileSplits {
  return readRepository(root, dir).files[relPath] ?? {};
}

/** Plenty for any real file, and a bound on what one request can write. */
const MAX_KEYS = 500;
const MAX_BOUNDARIES = 1000;

const isBoundaryList = (value: unknown): value is number[] =>
  Array.isArray(value) &&
  value.length <= MAX_BOUNDARIES &&
  value.every((boundary) => Number.isInteger(boundary) && boundary > 0);

/** A `splits` value, or null if it is not a well-formed record. */
export function parseSplits(value: unknown): FileSplits | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;

  const entries = Object.entries(value);
  if (entries.length > MAX_KEYS || !entries.every(([, list]) => isBoundaryList(list))) {
    return null;
  }
  return Object.fromEntries(entries) as FileSplits;
}

interface SplitsBody {
  path: string;
  /** Null means the session's anchor project, as for every review route. */
  project: string | null;
  splits: FileSplits;
}

/** The splits route's PUT body, or null if it is malformed. */
export function parseSplitsBody(value: unknown): SplitsBody | null {
  if (typeof value !== "object" || value === null) return null;
  const { path, project, splits } = value as Record<string, unknown>;

  const parsed = parseSplits(splits);
  if (typeof path !== "string" || !path || !parsed) return null;
  return { path, project: typeof project === "string" ? project : null, splits: parsed };
}

/**
 * The keys a file's current diffs can still draw a cut on: each unstaged hunk
 * as a `stage` target, each staged one as an `unstage` target — the same pair
 * `stagingTargets` hands the editor.
 */
export function validSplitKeys(diffs: {
  staged: FileDiff | null;
  unstaged: FileDiff | null;
} | null): Set<string> {
  return new Set([
    ...(diffs?.unstaged?.hunks ?? []).map((hunk) => splitKey("stage", hunk)),
    ...(diffs?.staged?.hunks ?? []).map((hunk) => splitKey("unstage", hunk)),
  ]);
}

/**
 * `splits` without any key outside `valid`, and without empty entries.
 *
 * Boundaries are kept as given: whether one still fits its hunk is
 * `applySplits`'s question, answered at draw time against the hunk it is
 * applied to.
 */
export function pruneSplits(splits: FileSplits, valid: ReadonlySet<string>): FileSplits {
  return Object.fromEntries(
    Object.entries(splits).filter(
      ([key, boundaries]) => valid.has(key) && boundaries.length > 0,
    ),
  );
}

/**
 * Replace one file's cuts. An empty record removes the file's entry.
 *
 * Synchronous from read to write on purpose: two saves for different files of
 * one repository share this file, and with no `await` between the read and
 * the write neither can interleave with the other in one server process.
 */
export function writeFileSplits(
  root: string,
  relPath: string,
  splits: FileSplits,
  dir = SEMLA_STATE_DIR,
): void {
  const repository = readRepository(root, dir);
  if (Object.keys(splits).length === 0) delete repository.files[relPath];
  else repository.files[relPath] = splits;

  mkdirSync(join(dir, SPLIT_DIR), { recursive: true });
  writeFileSync(splitsPath(root, dir), `${JSON.stringify(repository, null, 2)}\n`, "utf8");
}
