import { describe, expect, it } from "vitest";

import { parseUnifiedDiff } from "@/lib/pi/review/review-diff";
import type { FileDiff } from "@/lib/review/review-types";

import {
  hunkRangeKey,
  matchFullHunk,
  matchHunkAction,
} from "./review-hunk-match.ts";

/** Parse real diff text so the hunks under test are the ones git produces. */
const diffOf = (diff: string): FileDiff => parseUnifiedDiff(diff)[0];

// One hunk, entirely unstaged.
const UNSTAGED_ONE_HUNK = diffOf(`diff --git a/f.ts b/f.ts
index 1111111..2222222 100644
--- a/f.ts
+++ b/f.ts
@@ -1,3 +1,3 @@
 const keep = 1;
-const before = 2;
+const after = 2;
 const tail = 3;
`);

// The same file, same hunk, staged instead.
const STAGED_ONE_HUNK = diffOf(`diff --git a/f.ts b/f.ts
index 1111111..2222222 100644
--- a/f.ts
+++ b/f.ts
@@ -1,3 +1,3 @@
 const keep = 1;
-const before = 2;
+const after = 2;
 const tail = 3;
`);

// A second, unrelated hunk further down the same file.
const UNSTAGED_TWO_HUNKS = diffOf(`diff --git a/f.ts b/f.ts
index 1111111..2222222 100644
--- a/f.ts
+++ b/f.ts
@@ -1,3 +1,3 @@
 const keep = 1;
-const before = 2;
+const after = 2;
 const tail = 3;
@@ -10,2 +10,2 @@ function tail() {
-const x = 1;
+const x = 2;
 return x;
`);

describe("matchHunkAction", () => {
  it("offers to stage a hunk that matches an unstaged range", () => {
    const fullHunk = UNSTAGED_ONE_HUNK.hunks[0];
    const action = matchHunkAction(fullHunk, {
      staged: null,
      unstaged: UNSTAGED_ONE_HUNK,
    });
    expect(action).toEqual({ direction: "stage", index: 0 });
  });

  it("offers to unstage a hunk that matches a staged range", () => {
    const fullHunk = STAGED_ONE_HUNK.hunks[0];
    const action = matchHunkAction(fullHunk, {
      staged: STAGED_ONE_HUNK,
      unstaged: null,
    });
    expect(action).toEqual({ direction: "unstage", index: 0 });
  });

  it("matches the right hunk by range when a file has more than one", () => {
    const secondHunk = UNSTAGED_TWO_HUNKS.hunks[1];
    const action = matchHunkAction(secondHunk, {
      staged: null,
      unstaged: UNSTAGED_TWO_HUNKS,
    });
    expect(action).toEqual({ direction: "stage", index: 1 });
  });

  it("prefers unstaged over staged when both somehow contain the range", () => {
    const fullHunk = UNSTAGED_ONE_HUNK.hunks[0];
    const action = matchHunkAction(fullHunk, {
      staged: STAGED_ONE_HUNK,
      unstaged: UNSTAGED_ONE_HUNK,
    });
    expect(action).toEqual({ direction: "stage", index: 0 });
  });

  it("finds no action when the range matches neither diff", () => {
    const fullHunk = UNSTAGED_ONE_HUNK.hunks[0];
    const action = matchHunkAction(fullHunk, { staged: null, unstaged: null });
    expect(action).toBeNull();
  });
});

describe("hunkRangeKey", () => {
  it("is the same key for a hunk before and after it moves to the other diff", () => {
    // The whole point: a hunk staged out of UNSTAGED_ONE_HUNK becomes
    // STAGED_ONE_HUNK's hunk, same range, different diff — which is exactly
    // the move the review panel's stage animation keys its layoutId on.
    expect(hunkRangeKey(UNSTAGED_ONE_HUNK.hunks[0])).toBe(
      hunkRangeKey(STAGED_ONE_HUNK.hunks[0]),
    );
  });

  it("differs for two unrelated hunks in the same file", () => {
    const [first, second] = UNSTAGED_TWO_HUNKS.hunks;
    expect(hunkRangeKey(first)).not.toBe(hunkRangeKey(second));
  });
});

// The diff Monaco actually colours, against HEAD — same range as the two
// staged/unstaged fixtures above, which is the whole point: the keyboard
// cursor addresses a staged/unstaged hunk, and the editor highlight needs
// the corresponding hunk in this diff's own numbering.
const FULL_ONE_HUNK = diffOf(`diff --git a/f.ts b/f.ts
index 1111111..2222222 100644
--- a/f.ts
+++ b/f.ts
@@ -1,3 +1,3 @@
 const keep = 1;
-const before = 2;
+const after = 2;
 const tail = 3;
`);

describe("matchFullHunk", () => {
  it("finds the full-diff hunk with the same range as a staged or unstaged one", () => {
    const staged = STAGED_ONE_HUNK.hunks[0];
    expect(matchFullHunk(staged, FULL_ONE_HUNK.hunks)).toEqual(
      FULL_ONE_HUNK.hunks[0],
    );

    const unstaged = UNSTAGED_ONE_HUNK.hunks[0];
    expect(matchFullHunk(unstaged, FULL_ONE_HUNK.hunks)).toEqual(
      FULL_ONE_HUNK.hunks[0],
    );
  });

  it("is null when full has not loaded, or has no matching range", () => {
    const hunk = UNSTAGED_ONE_HUNK.hunks[0];
    expect(matchFullHunk(hunk, null)).toBeNull();
    expect(matchFullHunk(hunk, undefined)).toBeNull();

    const unrelated = UNSTAGED_TWO_HUNKS.hunks[1];
    expect(matchFullHunk(unrelated, FULL_ONE_HUNK.hunks)).toBeNull();
  });
});
