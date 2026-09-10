import { describe, expect, it } from "vitest";

import { shouldAutoScroll, type AutoScrollState } from "./review-auto-scroll.ts";

describe("shouldAutoScroll", () => {
  const fresh: AutoScrollState = { scrolledPath: null };

  it("scrolls when a file is first opened", () => {
    expect(shouldAutoScroll(fresh, "src/foo.ts")).toBe(true);
  });

  it("does not scroll again for the same file", () => {
    // Regression: a stage/unstage/commit invalidates the hunks query, which
    // delivers a new array for the same file. That used to re-fire the
    // auto-scroll effect and yank the viewport off wherever the reader was.
    const state: AutoScrollState = { scrolledPath: "src/foo.ts" };
    expect(shouldAutoScroll(state, "src/foo.ts")).toBe(false);
  });

  it("scrolls again once a different file is opened", () => {
    const state: AutoScrollState = { scrolledPath: "src/foo.ts" };
    expect(shouldAutoScroll(state, "src/bar.ts")).toBe(true);
  });

  it("scrolls a file reopened after another was shown in between", () => {
    // Selection moved away and back, so the reader has lost their place in
    // it anyway and landing on the first change is right again.
    const state: AutoScrollState = { scrolledPath: "src/bar.ts" };
    expect(shouldAutoScroll(state, "src/foo.ts")).toBe(true);
  });
});
