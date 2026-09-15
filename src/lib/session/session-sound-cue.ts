/**
 * Whether an out-of-focus session should play a sound cue right now.
 *
 * Pure transition detection, kept apart from the hook that plays audio: the
 * hook has side effects (an `Audio` element, `document.hasFocus()`) that make
 * it awkward to unit test, while the decision itself — "did this state just
 * start/stop, and is the tab out of focus" — does not.
 */

export interface SoundCueState {
  /** A turn is in flight for this session (submitting or reconnecting). */
  isActive: boolean;
  /** `ask_user` is waiting on an answer. */
  hasPendingQuestion: boolean;
}

/**
 * A question just arrived (pending question went false -> true) while the
 * session is not the one the operator is looking at.
 */
export function shouldPlayQuestionSound(
  previous: SoundCueState,
  next: SoundCueState,
  focused: boolean,
): boolean {
  if (focused) return false;
  return !previous.hasPendingQuestion && next.hasPendingQuestion;
}

/**
 * A turn just finished (active went true -> false) while the session is not
 * the one the operator is looking at.
 *
 * A turn that ends with a question pending is not "done" from the operator's
 * point of view — it is waiting on them — so that case is left to
 * `shouldPlayQuestionSound` instead of double-cueing here.
 */
export function shouldPlayDoneSound(
  previous: SoundCueState,
  next: SoundCueState,
  focused: boolean,
): boolean {
  if (focused) return false;
  if (next.hasPendingQuestion) return false;
  return previous.isActive && !next.isActive;
}
