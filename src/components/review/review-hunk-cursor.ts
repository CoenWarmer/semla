/**
 * Where keyboard review is, and where each key takes it.
 *
 * The keyboard loop moves through every changed hunk of every changed file in
 * order, and stages the one it is on. That is a *cursor* over data the review
 * panel already fetches, so it is a pure reducer here rather than state spread
 * through `ReviewChangedFiles` — the ordering rules below are the whole
 * feature, and none of them need a DOM to be true.
 *
 * Two things make the shape less obvious than "an index into a list".
 *
 * **Hunks arrive one file at a time.** `useReviewHunks` is per file, so the
 * hunks of the *next* file are not loaded at the moment `d` runs off the end of
 * this one. A cross-file move therefore cannot name an index; it names an
 * `edge` — "the first hunk of that file, whichever it turns out to be" — which
 * `resolveSlot` turns into a concrete hunk once that file's diff loads. This is
 * what lets navigation cross a file boundary without a fetch in the keypress
 * path, and what lets a file with no navigable hunks (binary, a mode change) be
 * stepped straight through.
 *
 * **Staging renumbers the diff.** `Hunk.index` is a position within one diff
 * read, so staging hunk 1 of three re-reads the diff and makes the old hunk 2
 * into hunk 1. The cursor is therefore addressed *group-relative* —
 * `{ group: "unstaged", index: 1 }` — and `positionAfterApply` deliberately
 * holds that same address rather than incrementing it: after the re-read, the
 * old index already points at the following hunk. Incrementing would skip one,
 * which is the bug this module exists to not have.
 *
 * Node-free and free of React, like review-hunk-match.ts and for the same
 * reason: every rule here is unit-testable without Monaco or a query client.
 */

import type { FileDiff } from "@/lib/review/review-types";

/** Which of the two diffs a hunk came from. See `ReviewHunkList` for why the
 * two are never merged into one numbering. */
export type HunkGroup = "staged" | "unstaged";

/** One hunk of one file, addressed the way the staging API addresses it. */
export interface HunkSlot {
  group: HunkGroup;
  /** `Hunk.index` within that group's diff. */
  index: number;
}

/** A changed file, in the terms the panel selects files by. */
export interface CursorFile {
  project: string;
  path: string;
}

/**
 * What the cursor is aimed at within its file: a specific hunk, or an end of
 * the file whose hunks are not loaded yet.
 */
export type CursorTarget = HunkSlot | { edge: "first" | "last" };

export interface HunkCursor {
  file: CursorFile;
  target: CursorTarget;
}

/** The two diffs of one file, as `useReviewHunks` answers them. */
export interface FileDiffs {
  staged: FileDiff | null;
  unstaged: FileDiff | null;
}

const isEdge = (target: CursorTarget): target is { edge: "first" | "last" } =>
  "edge" in target;

export const sameFile = (a: CursorFile, b: CursorFile): boolean =>
  a.project === b.project && a.path === b.path;

const fileIndex = (files: readonly CursorFile[], file: CursorFile): number =>
  files.findIndex((candidate) => sameFile(candidate, file));

/**
 * Every hunk of one file, in the order the sidebar draws them: staged first,
 * then not staged.
 *
 * A file whose diff has not loaded yet has no slots, which is the same answer
 * as a file with nothing to step through — and both are handled by the caller
 * moving on, so they do not need to be told apart here.
 */
export function hunkSlots(diffs: FileDiffs | null | undefined): HunkSlot[] {
  if (!diffs) return [];
  return [
    ...(diffs.staged?.hunks ?? []).map(
      (hunk): HunkSlot => ({ group: "staged", index: hunk.index }),
    ),
    ...(diffs.unstaged?.hunks ?? []).map(
      (hunk): HunkSlot => ({ group: "unstaged", index: hunk.index }),
    ),
  ];
}

const slotPosition = (slots: readonly HunkSlot[], slot: HunkSlot): number =>
  slots.findIndex(
    (candidate) =>
      candidate.group === slot.group && candidate.index === slot.index,
  );

/**
 * The hunk the cursor is on, given that file's loaded slots — or null when
 * there is none to be on.
 *
 * A slot target that no longer exists is *clamped within its own group* rather
 * than dropped: staging the last unstaged hunk of a file leaves an address one
 * past the end, and landing on the new last hunk of that group is what keeps
 * the cursor inside the file the operator is reading. Clamping only happens
 * within a group, because the two groups mean different things — falling from
 * "not staged" into "staged" would silently turn the next space press from a
 * stage into an unstage.
 */
export function resolveSlot(
  slots: readonly HunkSlot[],
  target: CursorTarget,
): HunkSlot | null {
  if (slots.length === 0) return null;

  if (isEdge(target)) {
    return (target.edge === "first" ? slots[0] : slots[slots.length - 1]) ?? null;
  }

  const exact = slots.find(
    (slot) => slot.group === target.group && slot.index === target.index,
  );
  if (exact) return exact;

  const withinGroup = slots.filter((slot) => slot.group === target.group);
  if (withinGroup.length === 0) return null;

  const clamped = Math.min(Math.max(target.index, 0), withinGroup.length - 1);
  return withinGroup[clamped] ?? null;
}

/** The cursor to start from when nothing has been navigated yet. */
export function initialCursor(
  files: readonly CursorFile[],
  selected: CursorFile | null,
): HunkCursor | null {
  const start = selected && fileIndex(files, selected) >= 0 ? selected : files[0];
  if (!start) return null;
  return { file: start, target: { edge: "first" } };
}

/** Aim the cursor at a file the operator picked by other means — a click. */
export const cursorForFile = (file: CursorFile): HunkCursor => ({
  file,
  target: { edge: "first" },
});

const neighbourFile = (
  files: readonly CursorFile[],
  file: CursorFile,
  delta: 1 | -1,
): CursorFile | null => {
  const at = fileIndex(files, file);
  if (at < 0) return null;
  return files[at + delta] ?? null;
};

/**
 * One hunk forward or back, rolling into the neighbouring file at either end.
 *
 * Returns the cursor unchanged at the very ends of the whole sequence — the
 * first hunk of the first file, the last of the last. It does not wrap around,
 * because a wrap on a surface whose point is "decide each one once" reads as
 * the cursor having been lost rather than as having reached the end.
 */
export function moveHunk({
  cursor,
  delta,
  files,
  slots,
}: {
  cursor: HunkCursor;
  delta: 1 | -1;
  files: readonly CursorFile[];
  /** Slots of `cursor.file` only; the neighbours' are not loaded. */
  slots: readonly HunkSlot[];
}): HunkCursor {
  const current = resolveSlot(slots, cursor.target);
  const at = current ? slotPosition(slots, current) : -1;
  const next = slots[at + delta];

  // Within this file, and loaded: an exact address.
  if (current && next) return { file: cursor.file, target: next };

  const neighbour = neighbourFile(files, cursor.file, delta);
  if (!neighbour) return cursor;

  // Entering a file whose hunks are not loaded yet, from the side the move
  // came from: forwards lands on its first hunk, backwards on its last.
  return {
    file: neighbour,
    target: { edge: delta === 1 ? "first" : "last" },
  };
}

/**
 * The next or previous file, landing on its first hunk either way.
 *
 * "First" in both directions, unlike `moveHunk`: `w` and `s` are a move
 * between files rather than a continuation of a walk through hunks, and the
 * top of a file is where reading it starts.
 */
export function moveFile({
  cursor,
  delta,
  files,
}: {
  cursor: HunkCursor;
  delta: 1 | -1;
  files: readonly CursorFile[];
}): HunkCursor {
  const neighbour = neighbourFile(files, cursor.file, delta);
  if (!neighbour) return cursor;
  return { file: neighbour, target: { edge: "first" } };
}

/**
 * Where the cursor goes once the hunk under it has been staged or unstaged.
 *
 * Deliberately the *same* group-relative address, not the next one. Applying a
 * hunk re-reads the diff, which removes it from its group and renumbers what
 * follows, so the address that named the applied hunk now names the one after
 * it. Only the last hunk of the file has nothing following it, and that rolls
 * into the next file the way `moveHunk` would.
 */
export function positionAfterApply({
  applied,
  cursor,
  files,
  slots,
}: {
  applied: HunkSlot;
  cursor: HunkCursor;
  files: readonly CursorFile[];
  slots: readonly HunkSlot[];
}): HunkCursor {
  const at = slotPosition(slots, applied);
  const isLastOfFile = at >= 0 && at === slots.length - 1;

  if (!isLastOfFile) return { file: cursor.file, target: applied };

  const neighbour = neighbourFile(files, cursor.file, 1);
  if (!neighbour) return { file: cursor.file, target: applied };
  return { file: neighbour, target: { edge: "first" } };
}

/** Which way `space` applies the hunk it is on: the opposite of where it is. */
export const applyDirection = (slot: HunkSlot): "stage" | "unstage" =>
  slot.group === "staged" ? "unstage" : "stage";

/** A reveal owed to a cursor move that could not name its line yet. */
export interface PendingReveal {
  file: CursorFile;
  /** The diff read the move was made against, as a react-query timestamp. */
  since: number;
}

/**
 * Whether the diff that has just arrived is the one a deferred reveal was
 * waiting for.
 *
 * Staging cannot reveal from the keypress: the hunk the cursor lands on does
 * not exist in the diff on hand, because that diff still contains the hunk
 * being staged. The reveal is therefore owed until the re-fetch lands, and
 * this is the whole of the rule that decides when that has happened.
 *
 * `"wait"` and `"drop"` are deliberately distinct. Waiting keeps the marker
 * for a later read; dropping discards it because the cursor has since moved to
 * another file, where the owed reveal would scroll the editor to a line in a
 * file the operator has left. Collapsing the two would make a stale reveal
 * fire eventually rather than never.
 *
 * The comparison is strictly greater than: react-query hands back a fresh
 * object for an unchanged answer, and re-rendering is not the answer arriving.
 */
export function revealAfterApply({
  cursorFile,
  dataUpdatedAt,
  pending,
}: {
  cursorFile: CursorFile | null;
  dataUpdatedAt: number;
  pending: PendingReveal | null;
}): "reveal" | "wait" | "drop" {
  if (!pending || !cursorFile) return "wait";
  if (!sameFile(pending.file, cursorFile)) return "drop";
  return dataUpdatedAt > pending.since ? "reveal" : "wait";
}
