/**
 * The point of these is the disclosure, not the formatting. A step's figures
 * are its *turn's* figures, and the one case where that is misleading — a turn
 * that made more than one call — must say so, or the strip reads as though
 * every dot independently cost that much.
 */
import { describe, expect, it } from "vitest";

import { describeStepUsage } from "./step-usage.ts";

describe("describeStepUsage", () => {
  it("reports tokens and cost for a turn that made one call", () => {
    expect(describeStepUsage({ callsInTurn: 1, cost: 0.072_724, tokens: 28_766 })).toBe(
      "28.8k tokens · $0.073",
    );
  });

  it("names the call count when a turn's figures are shared", () => {
    expect(describeStepUsage({ callsInTurn: 3, cost: 0.03, tokens: 12_600 })).toBe(
      "12.6k tokens · $0.030 for this turn (3 calls)",
    );
  });

  it("returns nothing when there is no usage to show", () => {
    expect(describeStepUsage(undefined)).toBeUndefined();
    // A live turn that has not closed reports zeroes rather than being absent;
    // rendering "0 tokens · $0" would claim the step was free.
    expect(describeStepUsage({ callsInTurn: 1, cost: 0, tokens: 0 })).toBeUndefined();
  });

  it("keeps a cheap call's cost non-zero", () => {
    expect(describeStepUsage({ callsInTurn: 1, cost: 0.000_04, tokens: 120 })).toBe(
      "120 tokens · $0.00004",
    );
  });
});
