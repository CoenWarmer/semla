/**
 * The identity a hunk's cuts are recorded against, shared by the editor that
 * makes them and the server that stores them.
 *
 * Here rather than beside the editor so the split store's pruning can compute
 * the same keys from a fresh diff read, and free of node imports for the same
 * reason the rest of `src/lib/review/` is (see review-types.ts).
 *
 * The key is three things, and each one is load-bearing:
 *
 * - **The direction**, because a staged and an unstaged hunk can share a
 *   range and are different things to cut.
 * - **The side of the range a sibling cannot move**: the worktree side of an
 *   unstaged hunk, the HEAD side of a staged one. The other side of each is
 *   the index, which every stage elsewhere in the file shifts — so a key that
 *   included it would lose a cut whenever a neighbouring hunk was staged.
 * - **A digest of the hunk's lines**, which is what makes staging a *part*
 *   retire the key. A range alone does not: stage only the removal of a
 *   one-line replacement and the unstaged hunk that remains has exactly the
 *   worktree span it had before, so a cut recorded against the old hunk would
 *   be re-applied to a different one.
 *
 * A digest rather than the lines themselves because keys are written to disk
 * (review-split-store.ts), and copying source text into Semla's state
 * directory to identify a cut is more than the job needs.
 */

import type { Hunk } from "./review-types";

export type SplitDirection = "stage" | "unstage";

/**
 * cyrb53: a 53-bit non-cryptographic string hash. Nothing here is
 * adversarial — a collision would need the same direction and the same range
 * as well — and it has to give the same answer in the browser and in node,
 * which rules out `node:crypto` and makes `crypto.subtle` (async) awkward.
 */
function digest(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let at = 0; at < text.length; at += 1) {
    const code = text.charCodeAt(at);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Where a staging hunk's cuts are recorded. See this file's docblock. */
export function splitKey(direction: SplitDirection, hunk: Hunk): string {
  const range =
    direction === "stage"
      ? `${hunk.newStart}:${hunk.newLines}`
      : `${hunk.oldStart}:${hunk.oldLines}`;
  const content = digest(JSON.stringify(hunk.lines.map((line) => [line.kind, line.text])));
  return `${direction}:${range}:${content}`;
}
