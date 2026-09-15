/**
 * Which characters within a changed line actually changed.
 *
 * The review editor colours a changed line and then, within it, the parts that
 * differ — so a line whose one identifier was renamed reads as a renamed
 * identifier rather than as a wholly rewritten line.
 *
 * Computed here rather than asked of git. `git diff --word-diff=porcelain`
 * knows this, but its output has to be mapped back to column offsets in the
 * post-image line, and that mapping is the part that goes wrong. A pure
 * function over two strings is deterministic, needs no subprocess, and can be
 * tested exhaustively — which for a feature whose product is traceability is
 * worth more than reusing git's answer.
 *
 * Node-free on purpose so it stays testable and cheap; it is used server-side,
 * and the spans travel to the client as data.
 */

import type { CharSpan } from "@/lib/review-types";

/**
 * Past this many tokens on either side the token LCS is abandoned for the
 * cheap prefix/suffix answer.
 *
 * The DP table is |a| x |b| cells, so an unbounded pair of minified lines —
 * one 40,000-character bundle line against another — is millions of cells for
 * a result nobody can read anyway. The fallback is never wrong, only coarser.
 */
const MAX_TOKENS = 400;

/**
 * Split into words, whitespace runs, and single punctuation characters.
 *
 * Word-level rather than character-level because character-level spans on
 * source code produce confetti: renaming `readGitStatus` to `readGitState`
 * should colour the suffix, not every letter that happens to coincide.
 */
export function tokenize(text: string): string[] {
  return text.match(/[A-Za-z0-9_$]+|\s+|[^A-Za-z0-9_$\s]/g) ?? [];
}

/** Characters shared at the start of both strings. */
export function commonPrefix(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) i += 1;
  return i;
}

/**
 * Characters shared at the end of both strings, never overlapping a prefix
 * already claimed — `"aa"` against `"aaa"` must not count the same `a` twice.
 */
export function commonSuffix(a: string, b: string, prefix: number): number {
  const limit = Math.min(a.length, b.length) - prefix;
  let i = 0;
  while (i < limit && a[a.length - 1 - i] === b[b.length - 1 - i]) i += 1;
  return i;
}

/** The single span left when the shared ends are trimmed off, or none. */
function trimmedSpan(a: string, b: string): CharSpan[] {
  const prefix = commonPrefix(a, b);
  const suffix = commonSuffix(a, b, prefix);
  const end = b.length - suffix;
  return end > prefix ? [{ end, start: prefix }] : [];
}

/**
 * Token indices in `b` that have no partner in `a`, by longest common
 * subsequence.
 *
 * Classic O(n*m) DP. Bounded by MAX_TOKENS above, so the table is at most
 * 160,000 cells.
 */
function unmatchedTokens(a: string[], b: string[]): boolean[] {
  const rows = a.length;
  const cols = b.length;
  const table: number[][] = Array.from({ length: rows + 1 }, () =>
    new Array<number>(cols + 1).fill(0),
  );

  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i][j] =
        a[i] === b[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const unmatched = new Array<boolean>(cols).fill(true);
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (a[i] === b[j]) {
      unmatched[j] = false;
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }

  return unmatched;
}

/** Adjacent runs of unmatched tokens, as offsets into `b`. */
function spansFromTokens(tokens: string[], unmatched: boolean[]): CharSpan[] {
  const spans: CharSpan[] = [];
  let offset = 0;
  let open: number | null = null;

  tokens.forEach((token, index) => {
    if (unmatched[index]) {
      if (open === null) open = offset;
    } else if (open !== null) {
      spans.push({ end: offset, start: open });
      open = null;
    }
    offset += token.length;
  });

  if (open !== null) spans.push({ end: offset, start: open });
  return spans;
}

/**
 * Trailing whitespace-only spans are dropped: a line whose only change is
 * indentation is already coloured as a changed line, and a span over blanks
 * renders as a coloured void that reads like a bug.
 */
const isBlank = (text: string, span: CharSpan) =>
  text.slice(span.start, span.end).trim() === "";

/**
 * The runs of `after` that differ from `before`.
 *
 * Call it once per direction: the spans for a removed line are
 * `changedSpans(after, before)`, because "which characters of this line are
 * not in the other one" is the same question with the arguments swapped.
 *
 * Identical strings yield no spans. A line paired with nothing yields none
 * either — the caller passes no counterpart, and a wholly new line is already
 * coloured as new.
 */
export function changedSpans(before: string, after: string): CharSpan[] {
  // Every path returns through the blank filter. It used to be applied only to
  // the token result, so a line whose sole change was its indentation took the
  // "nothing shared in the middle" shortcut and came back with a span over
  // four spaces — the exact artefact the filter exists to remove.
  return spansOf(before, after).filter((span) => !isBlank(after, span));
}

function spansOf(before: string, after: string): CharSpan[] {
  if (before === after || after.length === 0) return [];

  const prefix = commonPrefix(before, after);
  const suffix = commonSuffix(before, after, prefix);

  // The differing middles. Everything outside them is shared by construction,
  // so the token diff only has to consider what is left.
  const beforeMiddle = before.slice(prefix, before.length - suffix);
  const afterMiddle = after.slice(prefix, after.length - suffix);

  if (afterMiddle.length === 0) return [];
  if (beforeMiddle.length === 0) {
    return [{ end: prefix + afterMiddle.length, start: prefix }];
  }

  const beforeTokens = tokenize(beforeMiddle);
  const afterTokens = tokenize(afterMiddle);

  if (beforeTokens.length > MAX_TOKENS || afterTokens.length > MAX_TOKENS) {
    return trimmedSpan(before, after);
  }

  const unmatched = unmatchedTokens(beforeTokens, afterTokens);
  return spansFromTokens(afterTokens, unmatched).map((span) => ({
    end: span.end + prefix,
    start: span.start + prefix,
  }));
}
