import { describe, expect, it } from "vitest";

import { reviewHunkAction, type ReviewKeyEvent } from "./review-hunk-keys.ts";

const press = (overrides: Partial<ReviewKeyEvent>): ReviewKeyEvent => ({
  altKey: false,
  ctrlKey: false,
  inEditable: false,
  key: "d",
  metaKey: false,
  ...overrides,
});

describe("reviewHunkAction", () => {
  it("maps the navigation and staging keys", () => {
    expect(reviewHunkAction(press({ key: "d" }))).toBe("next-hunk");
    expect(reviewHunkAction(press({ key: "a" }))).toBe("previous-hunk");
    expect(reviewHunkAction(press({ key: "s" }))).toBe("next-file");
    expect(reviewHunkAction(press({ key: "w" }))).toBe("previous-file");
    expect(reviewHunkAction(press({ key: " " }))).toBe("apply-hunk");
  });

  it("treats a shifted letter as the same key", () => {
    expect(reviewHunkAction(press({ key: "D" }))).toBe("next-hunk");
  });

  it("ignores anything unmapped", () => {
    expect(reviewHunkAction(press({ key: "q" }))).toBeNull();
    expect(reviewHunkAction(press({ key: "Enter" }))).toBeNull();
  });

  // Cmd+S is save, Cmd+D is the browser's.
  it("ignores a key held with a modifier", () => {
    expect(reviewHunkAction(press({ key: "s", metaKey: true }))).toBeNull();
    expect(reviewHunkAction(press({ key: "d", ctrlKey: true }))).toBeNull();
    expect(reviewHunkAction(press({ altKey: true, key: "a" }))).toBeNull();
  });

  // The commit message input and Monaco both own their own letters.
  it("ignores every key typed into an editable target", () => {
    for (const key of ["a", "d", "s", "w", " "]) {
      expect(reviewHunkAction(press({ inEditable: true, key }))).toBeNull();
    }
  });
});
