/**
 * The pure arithmetic behind the stage/unstage bracket's height, kept apart
 * from `review-hunk-bracket-widgets.tsx` (which imports Monaco directly) so
 * it can be tested without a DOM or a Monaco instance — the same split
 * `review-decorations.ts` makes for the decoration mapping it feeds Monaco.
 */

/**
 * How many lines of the bracket are still relevant once Monaco has clamped
 * the widget's anchor to the top of the viewport.
 *
 * Monaco positions an `IGlyphMarginWidget` at
 * `max(range.startLineNumber, visibleStartLineNumber)`
 * (`glyphMargin.js`, `_collectWidgetBasedGlyphRenderRequest`) whenever any
 * part of the widget's range overlaps the viewport — which, for the bracket
 * widget, is the hunk's full `startLine..endLine` span, not just its anchor
 * line. So for a hunk taller than the viewport, once `startLine` has
 * scrolled above the top of the editor, the widget's rendered position is no
 * longer `startLine` but the viewport's own top line. A bracket still sized
 * for the original `startLine..endLine` span would then draw past `endLine`
 * on screen, since it now grows downward from a lower anchor. This computes
 * the line span that is actually still below the (possibly clamped) anchor,
 * so the bracket's rendered height can be recomputed to match.
 *
 * Returns 1 when the hunk's whole span has scrolled past (there is nothing
 * left to bracket) so callers always have at least one line's height to
 * work with, matching the single-line fast path.
 */
export function hunkBracketLineCount(
  entry: { startLine: number; endLine: number },
  visibleTopLine: number,
): number {
  const effectiveStartLine = Math.max(entry.startLine, visibleTopLine);
  return Math.max(1, entry.endLine - effectiveStartLine + 1);
}
