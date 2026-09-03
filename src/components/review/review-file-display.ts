/**
 * How a changed file is labelled in the bucket.
 *
 * Pure and separate so the letter and the tone for each status are asserted in
 * a test rather than read off a JSX tree — there are eight statuses and the
 * ones that matter most (a deletion, a conflict) are the ones a reviewer sees
 * least often and can least afford to misread.
 */

import type { ChangeStatus } from "@/lib/review-types";

/** git's own letter, which anyone who has run `git status` already knows. */
export const STATUS_LABEL: Record<ChangeStatus, string> = {
  added: "A",
  copied: "C",
  deleted: "D",
  modified: "M",
  renamed: "R",
  "type-changed": "T",
  unmerged: "!",
  untracked: "?",
};

export type StatusTone = "added" | "removed" | "changed" | "attention";

export const STATUS_TONE: Record<ChangeStatus, StatusTone> = {
  added: "added",
  copied: "changed",
  deleted: "removed",
  modified: "changed",
  renamed: "changed",
  "type-changed": "changed",
  // A conflict is not a change to review; it is a repository that needs
  // attention before any of this means anything.
  unmerged: "attention",
  untracked: "added",
};

export const TONE_CLASS: Record<StatusTone, string> = {
  added: "text-emerald-500",
  attention: "text-destructive font-bold",
  changed: "text-amber-500",
  removed: "text-destructive",
};

/**
 * A path split so the filename can be read first and the directory dimmed.
 *
 * A bucket of twenty files in `src/lib/pi/` is unreadable when every row leads
 * with the same forty characters.
 */
export function splitPath(path: string): { dir: string; name: string } {
  const index = path.lastIndexOf("/");
  return index === -1
    ? { dir: "", name: path }
    : { dir: path.slice(0, index + 1), name: path.slice(index + 1) };
}

/** How a rename reads in one line: the old name, then the new. */
export function renameLabel(oldPath: string | null, path: string): string {
  if (!oldPath) return splitPath(path).name;
  return `${splitPath(oldPath).name} → ${splitPath(path).name}`;
}
