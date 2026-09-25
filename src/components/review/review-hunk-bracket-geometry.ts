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
/**
 * Where lines are, in the editor's vertical pixel space — Monaco's
 * `getTopForLineNumber(line)` and `getBottomForLineNumber(line)`, which
 * already account for view zones (comment cards, explanations) between lines.
 */
export interface LineGeometry {
  lineCount: number;
  /** Top of the line itself, below any view zone above it. */
  top: (line: number) => number;
  /** Bottom of the line itself, above any view zone below it. */
  bottom: (line: number) => number;
}

/**
 * The line Monaco clamps a glyph widget's anchor to: the first line any part
 * of which is below `scrollTop` — `getLineNumberAtOrAfterVerticalOffset`,
 * which is what feeds `visibleStartLineNumber` in `glyphMargin.js`.
 *
 * A division by the line height gives the same answer only while no view
 * zone is above the viewport; each one shifts every later line down by its
 * own height, so this searches the real offsets instead.
 */
export function visibleTopLine(geometry: LineGeometry, scrollTop: number): number {
  let low = 1;
  let high = Math.max(1, geometry.lineCount);
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (geometry.bottom(mid) > scrollTop) high = mid;
    else low = mid + 1;
  }
  return low;
}

/**
 * The bracket's height in pixels, from its (possibly clamped) anchor line to
 * the bottom of `endLine`.
 *
 * Measured rather than `lineCount * lineHeight`, because a view zone inside
 * the span — a comment card between two of the hunk's lines — is painted
 * between them, and a bracket sized by line count alone stops that many
 * pixels short of the hunk's last line.
 */
export function hunkBracketHeight(
  entry: { startLine: number; endLine: number },
  topLine: number,
  geometry: LineGeometry,
): number {
  const { bottom, top } = hunkBracketSpan(entry, topLine, geometry);
  return bottom - top;
}

/** The bracket's top and bottom in the editor's pixel space. See `hunkBracketHeight`. */
export function hunkBracketSpan(
  entry: { startLine: number; endLine: number },
  topLine: number,
  geometry: LineGeometry,
): { top: number; bottom: number } {
  const anchor = Math.min(Math.max(entry.startLine, topLine), entry.endLine);
  return { bottom: geometry.bottom(entry.endLine), top: geometry.top(anchor) };
}

/**
 * Where the stage/unstage button's centre goes, in pixels from the bracket's
 * top: the middle of the part of the bracket that is on screen.
 *
 * For a bracket wholly in view that is the middle of the bracket; for one
 * taller than the viewport it is the middle of the viewport, so the button
 * does not scroll off with the hunk's middle. Clamped so the button never
 * hangs past either end of the bracket, and falls back to the bracket's own
 * middle when none of it is visible.
 */
export function hunkButtonCenter(
  bracket: { top: number; bottom: number },
  viewport: { top: number; bottom: number },
  buttonHalfHeight: number,
): number {
  const height = bracket.bottom - bracket.top;
  const visibleTop = Math.max(bracket.top, viewport.top);
  const visibleBottom = Math.min(bracket.bottom, viewport.bottom);
  const center =
    visibleBottom > visibleTop ? (visibleTop + visibleBottom) / 2 - bracket.top : height / 2;

  const min = Math.min(buttonHalfHeight, height / 2);
  const max = Math.max(height - buttonHalfHeight, height / 2);
  return Math.min(Math.max(center, min), max);
}

export function hunkBracketLineCount(
  entry: { startLine: number; endLine: number },
  visibleTopLine: number,
): number {
  const effectiveStartLine = Math.max(entry.startLine, visibleTopLine);
  return Math.max(1, entry.endLine - effectiveStartLine + 1);
}
