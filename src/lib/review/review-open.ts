/**
 * Whether the review panel should be on screen.
 *
 * A pure function rather than an effect that opens it, for two reasons. The
 * React Compiler rules this repository treats as errors forbid setting state
 * from an effect, and deriving the answer during render is also simply more
 * honest: the panel is open *because* of the state, not because something
 * happened to it once.
 *
 * The rules exist to stop it becoming an annoyance. A surface that appears
 * over the conversation has to be right about when it is wanted, or it gets
 * dismissed reflexively and stops being read at all.
 */

import type { FileAccess } from "@/lib/pi/file-access/access-types";
import { isEmptyReview, type SessionReview } from "@/lib/review/review-types";

export interface ReviewOpenInput {
  review: SessionReview | undefined;
  /** A turn is running. Nothing opens over work still in progress. */
  sessionRunning: boolean;
  /** The operator pressed the button, which overrides every rule below. */
  manuallyOpened: boolean;
}

/**
 * The panel opens by itself only when all of these hold:
 *
 *  - the turn has finished — a panel that appears mid-turn is describing a
 *    tree the agent is still writing to;
 *  - something actually changed *during this turn*, which is not the same as
 *    the tree being dirty: a working copy left dirty yesterday is dirty now,
 *    and opening on that is crying wolf;
 *  - the operator has not already dismissed this exact state.
 *
 * Manual opening ignores all three, so a dismissal is never a dead end.
 */
export function shouldOpenReview({
  manuallyOpened,
  review,
  sessionRunning,
}: ReviewOpenInput): boolean {
  if (manuallyOpened) return true;
  if (!review || sessionRunning) return false;
  if (review.reviewed) return false;
  if (isEmptyReview(review)) return false;

  return review.changedThisTurn;
}

/**
 * The newest live access that may open a closed panel, or null.
 *
 * Only a write qualifies. Reads are the overwhelming majority of what an agent
 * does — a turn that opens forty files to answer a question changed nothing,
 * and a panel that appeared for each of them would be closed once and never
 * read again. Reads still *navigate* a panel that is already open, which is
 * where following earns its keep.
 *
 * This is a deliberate exception to the argument in `shouldOpenReview`'s
 * docblock above, that a mid-turn panel describes a tree the agent is still
 * writing to. That is true and the operator overruled it for writes: watching
 * the edit land is the point. Do not "fix" this back — `sessionRunning` still
 * guards the automatic open, and this disjunct is the only way past it.
 *
 * Unopenable writes are skipped rather than stopping the search: the agent
 * writes to `/tmp` and to files outside every linked project, and neither can
 * be shown here, so treating one as the newest write would open an empty panel.
 */
export function openingWrite(
  accesses: readonly FileAccess[],
): FileAccess | null {
  for (let index = accesses.length - 1; index >= 0; index -= 1) {
    const access = accesses[index]!;
    if (access.kind === "write" && access.project !== null && !access.missing) {
      return access;
    }
  }
  return null;
}

/**
 * Whether a live write should have the panel on screen.
 *
 * `dismissedId` is the access the operator last closed the panel on, not a
 * boolean: a later write is a genuinely new event and should open the panel
 * again, while the one already dismissed must not reopen on the next refetch.
 * Tool call ids are unique across turns, so this survives the live-access list
 * being cleared when a turn ends.
 */
export function shouldFollowOpen({
  dismissedId,
  followMode,
  write,
}: {
  dismissedId: string | null;
  followMode: boolean;
  write: FileAccess | null;
}): boolean {
  if (!followMode || !write) return false;
  return write.id !== dismissedId;
}
