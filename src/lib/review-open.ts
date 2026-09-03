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

import { isEmptyReview, type SessionReview } from "@/lib/review-types";

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
