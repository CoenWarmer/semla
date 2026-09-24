import { describe, expect, it } from "vitest";

import { readPlaceReviewCommentsResult } from "./place-review-comments-result";

const validComment = {
  body: { kind: "text", text: "hi" },
  createdAt: "2026-01-01T00:00:00Z",
  endLine: 5,
  filePath: "a.ts",
  id: "c1",
  projectPath: "semla",
  startLine: 5,
};

describe("readPlaceReviewCommentsResult", () => {
  it("returns null for a result from an unrelated tool", () => {
    expect(readPlaceReviewCommentsResult({ details: { type: "code-map" } })).toBeNull();
  });

  it("returns null for a malformed result", () => {
    expect(readPlaceReviewCommentsResult(undefined)).toBeNull();
    expect(readPlaceReviewCommentsResult({ details: null })).toBeNull();
    expect(
      readPlaceReviewCommentsResult({ details: { results: "nope", type: "place-review-comments" } }),
    ).toBeNull();
  });

  it("extracts only the successful entries, in order", () => {
    const result = readPlaceReviewCommentsResult({
      details: {
        results: [
          { comment: validComment, index: 0, ok: true },
          { error: "nope", index: 1, ok: false, path: "b.ts" },
          { comment: { ...validComment, id: "c2" }, index: 2, ok: true },
        ],
        type: "place-review-comments",
      },
    });

    expect(result).toEqual([validComment, { ...validComment, id: "c2" }]);
  });

  it("returns an empty array when every entry failed", () => {
    const result = readPlaceReviewCommentsResult({
      details: {
        results: [{ error: "nope", index: 0, ok: false, path: "b.ts" }],
        type: "place-review-comments",
      },
    });

    expect(result).toEqual([]);
  });

  it("drops a malformed comment on an otherwise-ok entry", () => {
    const result = readPlaceReviewCommentsResult({
      details: {
        results: [{ comment: { body: { kind: "text" } }, index: 0, ok: true }],
        type: "place-review-comments",
      },
    });

    expect(result).toEqual([]);
  });
});
