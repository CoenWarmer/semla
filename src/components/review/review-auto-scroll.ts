/**
 * Whether the editor should auto-scroll to a file's first change.
 *
 * Pure, so the rule is testable without Monaco. The editor opens a file on
 * its first hunk rather than at line 1 — a review starts at what moved, and
 * a long file's first change is usually nowhere near the top.
 *
 * The subtlety is *how often*. The effect that does this depends on the
 * `hunks` array, and `invalidateAfterWrite` (see `use-review.ts`) invalidates
 * the hunks query after every stage, unstage and commit. That delivers a new
 * array for the same file, re-firing the effect and yanking the viewport back
 * to the first hunk — so staging a hunk after having arrived from a symbol
 * link, or after scrolling anywhere by hand, lost the reader's place.
 *
 * So the answer is once per opened file, not once per hunks array: track the
 * path last scrolled for and decline to scroll again until it changes.
 */

export interface AutoScrollState {
  /** The path this state last auto-scrolled for, or null before any. */
  scrolledPath: string | null;
}

/**
 * Whether `path` has yet to be auto-scrolled, given what was last scrolled.
 * Returning false for a repeat is what makes a staging refetch leave the
 * viewport alone.
 *
 * Deliberately not a `line is number` type predicate over the first hunk's
 * line, tempting though that is at the one call site: a predicate narrows
 * the *false* branch too, and this returns false for a perfectly good line
 * whenever the path is a repeat — so the narrowing would be a lie. A file
 * with no changes has nothing to go to, and the caller checks that itself.
 */
export function shouldAutoScroll(state: AutoScrollState, path: string): boolean {
  return state.scrolledPath !== path;
}
