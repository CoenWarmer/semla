/**
 * Re-find a captured hunk in the diff as it is now.
 *
 * A hunk recorded a turn or two ago has moved: lines above it changed, it was
 * partly staged, it was amended. Matching is therefore by decreasing
 * confidence, and the first rung that matches wins:
 *
 *   1. exact old/new range — the same match rule review-hunk-match.ts uses
 *      for staging, reused here for the same reason: an exact range is the
 *      only kind of match that needs no judgment call;
 *   2. same `heading` and the nearest `newStart` — git's `@@` trailer names
 *      the enclosing function or block, which survives edits made above it;
 *   3. the hunk whose `newStart` is nearest the anchor's;
 *   4. nothing, and the caller opens the file with no reveal, which lands on
 *      the editor's own first-hunk behaviour (`firstChangedLine`).
 *
 * Pure and separate from review-panel.tsx so every rung is testable without
 * Monaco, and so it can be applied as a *derivation* during render rather
 * than an effect. `react/set-state-in-effect` is an error in this repository,
 * and syncing a resolved line into state would also be a second source of
 * truth for where the reveal points.
 */

import type { HunkAnchor } from "@/lib/artifacts/artifact-types";
import type { Hunk } from "@/lib/review/review-types";

import type { PanelRequest, PanelTarget } from "./review-panel-request";

const sameRange = (anchor: HunkAnchor, hunk: Hunk): boolean =>
  anchor.oldStart === hunk.oldStart &&
  anchor.oldLines === hunk.oldLines &&
  anchor.newStart === hunk.newStart &&
  anchor.newLines === hunk.newLines;

const nearestByNewStart = (
  anchor: HunkAnchor,
  candidates: readonly Hunk[],
): Hunk | null => {
  let best: Hunk | null = null;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = Math.abs(candidate.newStart - anchor.newStart);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
};

/**
 * Re-find `anchor` in `hunks`, or null when nothing in the list is close
 * enough to call a match.
 */
export function matchAnchor(
  anchor: HunkAnchor,
  hunks: readonly Hunk[],
): Hunk | null {
  if (hunks.length === 0) return null;

  const exact = hunks.find((hunk) => sameRange(anchor, hunk));
  if (exact) return exact;

  if (anchor.heading !== null) {
    const sameHeading = hunks.filter((hunk) => hunk.heading === anchor.heading);
    const nearest = nearestByNewStart(anchor, sameHeading);
    if (nearest) return nearest;
  }

  return nearestByNewStart(anchor, hunks);
}

/**
 * `request` with its reveal corrected to the live position of `target`'s
 * anchor.
 *
 * Returns `request` unchanged (referentially) when there is no anchor, no
 * hunks yet, or no match — so a caller can memoize on the result safely and
 * so a target with no anchor costs nothing here.
 *
 * The nonce rule is the subtle part: the corrected reveal always carries
 * `target.nonce`, even when the matched line equals the request's own
 * `reveal.line`. The nonce identifies *the request the target made*, not the
 * line — so a correction arriving once the hunks load must still change
 * `reveal.line` without changing `reveal.nonce`, and the object it produces
 * must be a new one so Monaco's `reveal` effect (keyed on `{line, nonce}`)
 * fires again.
 */
export function anchorRevealRequest(
  request: PanelRequest,
  target: PanelTarget | null | undefined,
  hunks: readonly Hunk[] | undefined,
): PanelRequest {
  const anchor = target?.anchor;
  if (!anchor || !hunks || hunks.length === 0) return request;

  const match = matchAnchor(anchor, hunks);
  if (!match) return request;

  return {
    ...request,
    reveal: { line: match.newStart, nonce: target.nonce },
  };
}
