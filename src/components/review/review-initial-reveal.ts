/**
 * Whether opening the review panel on a target should also scroll the editor
 * to a line, and which.
 *
 * Pure and separate from `review-panel.tsx` so the distinction it encodes is
 * unit-testable without mounting Monaco: a target that names a file but no
 * line is a request to *open* that file, not to scroll anywhere in it.
 *
 * The two used to be conflated. `ElementTarget.line` was a required `number`
 * and `useFileTargetClick` filled the gap with `?? 1`, so every markdown file
 * link without a line — `[foo](src/foo.ts)`, the common form — arrived
 * indistinguishable from `src/foo.ts:1`. The panel then asked for a reveal of
 * line 1, which lands at the top of the file *and* overrides the editor's own
 * open-on-the-first-hunk behaviour (`firstChangedLine` in `code-editor.tsx`),
 * whose entire point is that a long file's first change is usually nowhere
 * near line 1. The element picker never hit this because a picked DOM element
 * always resolves to a real line.
 */

export interface InitialRevealTarget {
  line?: number;
}

export interface Reveal {
  line: number;
  nonce: number;
}

/**
 * The panel's initial `reveal` state for `target`, or null to ask for none.
 *
 * `nonce` starts at 1 rather than 0 so that a later `revealLine()` bump is
 * always a distinct value from the initial one, which is what makes asking
 * for the same line twice two requests rather than one unchanged prop.
 */
export function initialReveal(
  target: InitialRevealTarget | null | undefined,
): Reveal | null {
  if (target?.line === undefined) return null;
  return { line: target.line, nonce: 1 };
}
