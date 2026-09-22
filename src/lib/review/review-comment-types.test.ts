import { describe, expect, it } from "vitest";

import { isReviewCommentBody } from "./review-comment-types";

describe("isReviewCommentBody", () => {
  it("accepts a text body", () => {
    expect(isReviewCommentBody({ kind: "text", text: "hello" })).toBe(true);
  });

  it("accepts a markdown body", () => {
    expect(isReviewCommentBody({ kind: "markdown", markdown: "**hi**" })).toBe(true);
  });

  it("rejects a text body with a non-string text field", () => {
    expect(isReviewCommentBody({ kind: "text", text: 7 })).toBe(false);
  });

  it("rejects a markdown body with a non-string markdown field", () => {
    expect(isReviewCommentBody({ kind: "markdown", markdown: null })).toBe(false);
  });

  it("rejects an unknown kind", () => {
    expect(isReviewCommentBody({ kind: "warning", markdown: "x" })).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(isReviewCommentBody(null)).toBe(false);
    expect(isReviewCommentBody("text")).toBe(false);
    expect(isReviewCommentBody(42)).toBe(false);
    expect(isReviewCommentBody(undefined)).toBe(false);
  });

  it("rejects an object with no kind", () => {
    expect(isReviewCommentBody({ text: "hello" })).toBe(false);
  });
});
