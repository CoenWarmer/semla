"use client";

/**
 * Keyboard review, wired: the cursor of review-hunk-cursor.ts, the keymap of
 * review-hunk-keys.ts, and the one `keydown` listener that joins them.
 *
 * Lives in `ReviewChangedFiles` rather than in the panel or the editor. That
 * answers the open question in docs/plans/hunk-review.md §8 (Q2) the cheap
 * way: the sidebar is the surface that draws hunks as rows, so highlighting
 * where the cursor is costs nothing here, and Monaco — which swallows single
 * letters while it has focus — never needs a second registration. The keymap
 * suppresses itself inside the editor instead, which is also the behaviour
 * asked for: the keys act only when the editor does not have focus.
 *
 * The listener is on `document` for the same reason the panel's Escape
 * handler is: the review surface has no single focusable container, and a
 * handler on a div would only fire once something inside it had been clicked.
 *
 * Nothing here syncs props into state. The cursor is a single piece of state
 * with a derived fallback (`initialCursor`), because `react/set-state-in-effect`
 * is an error in this repository and a synced copy of the selection would be a
 * second source of truth for where the cursor is.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useReviewHunks } from "@/hooks/use-review";
import type { FileDiff, Hunk } from "@/lib/review/review-types";

import type { FileSelection, StageFileHunks } from "./review-changed-files";
import { hunkAnchorLine } from "./review-decorations";
import {
  applyDirection,
  cursorForFile,
  hunkSlots,
  initialCursor,
  moveFile,
  moveHunk,
  positionAfterApply,
  resolveSlot,
  revealAfterApply,
  sameFile,
  type CursorFile,
  type HunkCursor,
  type HunkSlot,
  type PendingReveal,
} from "./review-hunk-cursor";
import { isEditableTarget, reviewHunkAction } from "./review-hunk-keys";

/** Where the cursor is, in the terms a row needs to draw itself highlighted. */
export interface HunkCursorPosition {
  file: CursorFile;
  /** Null while that file's diff is still loading, or when it has no hunks. */
  slot: HunkSlot | null;
}

/** Whether `slot` of `file` is the hunk the keyboard cursor is on. */
export function isCurrentHunk(
  position: HunkCursorPosition | null,
  file: CursorFile,
  slot: HunkSlot,
): boolean {
  if (!position?.slot) return false;
  return (
    sameFile(position.file, file) &&
    position.slot.group === slot.group &&
    position.slot.index === slot.index
  );
}

const hunkAt = (diff: FileDiff | null, index: number): Hunk | undefined =>
  diff?.hunks.find((hunk) => hunk.index === index);

export function useReviewHunkKeyboard({
  enabled,
  expanded,
  files,
  onNavigate,
  onReveal,
  onStage,
  selected,
  sessionId,
}: {
  /**
   * False while there is nothing to drive — a commit is selected, so the
   * hunks on screen are history and have no index to stage into.
   */
  enabled: boolean;
  /**
   * The row currently folded open, or null when none is.
   *
   * Needed as well as `selected` because the cursor's highlight is drawn by
   * the hunk rows *inside* an open row: a move that lands in a collapsed
   * file is invisible, so it has to open it. That includes the very first
   * keypress, where the cursor is already in the selected file and the move
   * does not cross a file boundary at all.
   */
  expanded: FileSelection | null;
  /** Every changed file, in the order the sidebar lists them. */
  files: readonly CursorFile[];
  /** Open a file and fold its hunks open. Never a toggle: see below. */
  onNavigate: (selection: FileSelection) => void;
  onReveal: (line: number) => void;
  onStage: StageFileHunks;
  /** The file the panel currently has open, as the cursor's starting point. */
  selected: FileSelection | null;
  sessionId: string;
}): {
  position: HunkCursorPosition | null;
  /** Aim the cursor at a file the operator clicked, so `d` continues from it. */
  onFilePicked: (file: CursorFile) => void;
} {
  const [ownCursor, setOwnCursor] = useState<HunkCursor | null>(null);

  // Derived, not synced: a cursor the operator has not moved yet follows the
  // panel's own selection, and one they have moved is theirs.
  const cursor = useMemo(() => {
    if (ownCursor && files.some((file) => sameFile(file, ownCursor.file))) {
      return ownCursor;
    }
    return initialCursor(files, selected);
  }, [files, ownCursor, selected]);

  // The cursor file's diffs. Same query key the expanded row reads, so
  // react-query serves both from one fetch rather than two.
  const hunksQuery = useReviewHunks(
    sessionId,
    cursor?.file.project ?? null,
    cursor?.file.path ?? null,
  );
  const diffs = hunksQuery.data;
  const { dataUpdatedAt } = hunksQuery;

  const slots = useMemo(() => hunkSlots(diffs), [diffs]);
  const slot = useMemo(
    () => (cursor ? resolveSlot(slots, cursor.target) : null),
    [cursor, slots],
  );

  const position = useMemo(
    () => (cursor ? { file: cursor.file, slot } : null),
    [cursor, slot],
  );

  /**
   * Move the cursor, and bring the panel with it.
   *
   * Navigating rather than toggling is the point: the sidebar's click handler
   * closes an already-open row, which is right for a click and wrong for a
   * key — `d` off the end of a file must open the next one, never close it.
   *
   * A reveal is asked for only when the destination hunk is already known.
   * Crossing into a file whose diff has not loaded leaves the scroll to the
   * editor's own open-on-the-first-change behaviour, rather than revealing
   * from an effect once the fetch settles.
   */
  const go = useCallback(
    (next: HunkCursor) => {
      setOwnCursor(next);

      const alreadyOpen = expanded !== null && sameFile(expanded, next.file);
      if (!alreadyOpen) {
        onNavigate({ path: next.file.path, project: next.file.project });
      }

      if (!cursor || !sameFile(next.file, cursor.file)) return;

      const target = resolveSlot(slots, next.target);
      if (!target || !diffs) return;
      const hunk = hunkAt(
        target.group === "staged" ? diffs.staged : diffs.unstaged,
        target.index,
      );
      if (hunk) onReveal(hunkAnchorLine(hunk));
    },
    [cursor, diffs, expanded, onNavigate, onReveal, slots],
  );

  /**
   * A cursor move that is waiting on a re-fetch before it can be revealed.
   *
   * Staging is the case that needs it. `apply` knows *which* hunk the cursor
   * will land on — the address it already holds — but not what line that hunk
   * is at, because the hunk in question does not exist yet: the diff on hand
   * still contains the hunk that was just staged, and the one the cursor will
   * resolve to only appears once `invalidateAfterWrite` has re-fetched. So the
   * reveal cannot be issued from the keypress, and issuing the stale line
   * instead is what left the editor sitting on the hunk that had just gone.
   *
   * A ref rather than state: this is a one-shot marker consumed by the effect
   * below, and it must not itself cause the render that would re-run the
   * effect. Holding the `dataUpdatedAt` the stage was issued against is what
   * distinguishes the fresh diff from the one already in the cache — a
   * re-render alone must not be mistaken for the answer arriving.
   */
  const pendingReveal = useRef<PendingReveal | null>(null);

  const apply = useCallback(() => {
    if (!cursor || !slot) return;
    onStage(
      { path: cursor.file.path, project: cursor.file.project },
      [slot.index],
      applyDirection(slot),
    );
    // Computed against the pre-apply slots on purpose — see
    // `positionAfterApply` for why holding the address advances the cursor.
    const next = positionAfterApply({ applied: slot, cursor, files, slots });
    setOwnCursor(next);

    // Rolling into another file opens it, and the editor lands on that file's
    // first change by itself; only a move that stays put needs the reveal.
    if (sameFile(next.file, cursor.file)) {
      pendingReveal.current = { file: next.file, since: dataUpdatedAt };
    } else {
      pendingReveal.current = null;
      onNavigate({ path: next.file.path, project: next.file.project });
    }
  }, [cursor, dataUpdatedAt, files, onNavigate, onStage, slot, slots]);

  /**
   * Reveal the hunk the cursor landed on, once the post-stage diff arrives.
   *
   * Keyed on `dataUpdatedAt` rather than on the data: react-query hands back
   * a new object for an unchanged answer too, and the timestamp is the only
   * signal that says *this* read is newer than the one the stage was issued
   * against. Clearing the ref before revealing keeps it a one-shot, so a later
   * unrelated re-fetch of the same file does not scroll the editor again.
   */
  useEffect(() => {
    const verdict = revealAfterApply({
      cursorFile: cursor?.file ?? null,
      dataUpdatedAt,
      pending: pendingReveal.current,
    });

    if (verdict === "wait") return;
    pendingReveal.current = null;
    if (verdict === "drop" || !cursor || !diffs) return;

    const target = resolveSlot(hunkSlots(diffs), cursor.target);
    if (!target) return;
    const hunk = hunkAt(
      target.group === "staged" ? diffs.staged : diffs.unstaged,
      target.index,
    );
    if (hunk) onReveal(hunkAnchorLine(hunk));
  }, [cursor, dataUpdatedAt, diffs, onReveal]);

  useEffect(() => {
    if (!enabled || !cursor) return;

    const onKeyDown = (event: KeyboardEvent) => {
      const action = reviewHunkAction({
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        inEditable: isEditableTarget(event.target),
        key: event.key,
        metaKey: event.metaKey,
      });
      if (!action) return;

      // Space scrolls the page and the arrow-equivalents may be bound
      // elsewhere; a key this surface has claimed must not also do that.
      event.preventDefault();

      switch (action) {
        case "next-hunk":
          go(moveHunk({ cursor, delta: 1, files, slots }));
          return;
        case "previous-hunk":
          go(moveHunk({ cursor, delta: -1, files, slots }));
          return;
        case "next-file":
          go(moveFile({ cursor, delta: 1, files }));
          return;
        case "previous-file":
          go(moveFile({ cursor, delta: -1, files }));
          return;
        case "apply-hunk":
          apply();
          return;
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [apply, cursor, enabled, files, go, slots]);

  const onFilePicked = useCallback(
    (file: CursorFile) => setOwnCursor(cursorForFile(file)),
    [],
  );

  return { onFilePicked, position };
}
