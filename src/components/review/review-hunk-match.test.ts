import { describe, expect, it } from "vitest";

import { parseUnifiedDiff } from "@/lib/pi/review-diff";
import type { FileDiff } from "@/lib/review-types";

import { matchHunkAction } from "./review-hunk-match.ts";

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
