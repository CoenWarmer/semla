import { describe, expect, it } from "vitest";

import { addUsage, NO_USAGE } from "./session-usage.ts";

describe("addUsage", () => {
  it("sums every source", () => {
    // The real numbers from the session that exposed this: the conversation
    // was a twentieth of the bill, and one component was reporting each half
    // on its own.
    expect(
      addUsage({ cost: 0.05, tokens: 10_723 }, { cost: 0.0344, tokens: 1_045 }),
    ).toEqual({ cost: 0.0844, tokens: 11_768 });
  });

  it("does not treat a zero source as a reason to fall back", () => {
    // `runTokens > 0 ? runTokens : msgTokens` is what this replaces: it read
    // like a fallback and behaved like discarding half the bill.
    expect(addUsage({ cost: 0, tokens: 0 }, { cost: 1, tokens: 2 })).toEqual({
      cost: 1,
      tokens: 2,
    });
    expect(addUsage({ cost: 1, tokens: 2 }, { cost: 0, tokens: 0 })).toEqual({
      cost: 1,
      tokens: 2,
    });
  });

  it("skips absent sources", () => {
    expect(addUsage(undefined, { cost: 1, tokens: 2 }, undefined)).toEqual({
      cost: 1,
      tokens: 2,
    });
  });

  it("is zero for nothing at all", () => {
    expect(addUsage()).toEqual(NO_USAGE);
    expect(addUsage(undefined)).toEqual(NO_USAGE);
  });
});
