import { describe, expect, it } from "vitest";

import { initialReveal } from "./review-initial-reveal.ts";

describe("initialReveal", () => {
  it("asks for no reveal when there is no target at all", () => {
    expect(initialReveal(null)).toBeNull();
    expect(initialReveal(undefined)).toBeNull();
  });

  it("asks for no reveal when the target names a file but no line", () => {
    // Regression: this used to arrive as `line: 1` (a `?? 1` in
    // `useFileTargetClick`), which scrolled a plain `[foo](src/foo.ts)` link
    // to the top of the file and suppressed the editor's own
    // open-on-the-first-hunk behaviour.
    expect(initialReveal({})).toBeNull();
    expect(initialReveal({ line: undefined })).toBeNull();
  });

  it("reveals the named line", () => {
    expect(initialReveal({ line: 79 })).toEqual({ line: 79, nonce: 1 });
  });

  it("still reveals an explicitly requested line 1", () => {
    // The distinction the null case exists for: `src/foo.ts:1` genuinely
    // asked for the top of the file, and must not be folded into "no line".
    expect(initialReveal({ line: 1 })).toEqual({ line: 1, nonce: 1 });
  });
});
