import { describe, expect, it } from "vitest";

import { readOpenReviewResult } from "./open-review-result";

const validComment = {
  body: { kind: "text", text: "hi" },
  createdAt: "2026-01-01T00:00:00Z",
  endLine: 5,
  filePath: "a.ts",
  id: "c1",
  projectPath: "semla",
  startLine: 5,
};

describe("readOpenReviewResult", () => {
  it("returns null for a result from an unrelated tool", () => {
    expect(readOpenReviewResult({ details: { type: "code-map" } })).toBeNull();
  });

  it("returns null for a malformed result", () => {
    expect(readOpenReviewResult(undefined)).toBeNull();
    expect(readOpenReviewResult({ details: null })).toBeNull();
  });

  it("reads a target with no comment as comment: null", () => {
    const result = readOpenReviewResult({
      details: { target: { path: "a.ts", project: "semla" }, type: "open-review" },
    });
    expect(result).toEqual({
      comment: null,
      target: { path: "a.ts", project: "semla" },
      type: "open",
    });
  });

  it("reads target: null (\"just open it\") as comment: null", () => {
    const result = readOpenReviewResult({
      details: { target: null, type: "open-review" },
    });
    expect(result).toEqual({ comment: null, target: null, type: "open" });
  });

  it("reads a valid comment alongside its target", () => {
    const result = readOpenReviewResult({
      details: {
        comment: validComment,
        target: { path: "a.ts", project: "semla" },
        type: "open-review",
      },
    });
    expect(result?.comment).toEqual(validComment);
  });

  it("drops a malformed comment without losing the target", () => {
    const result = readOpenReviewResult({
      details: {
        comment: { body: { kind: "text" } },
        target: { path: "a.ts", project: "semla" },
        type: "open-review",
      },
    });
    expect(result).toEqual({
      comment: null,
      target: { path: "a.ts", project: "semla" },
      type: "open",
    });
  });
});
