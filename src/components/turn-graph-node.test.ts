/**
 * turnNodeSummary is the one place a node's second line is decided. The
 * property under test: it prefers what a turn actually did (tool calls,
 * tokens, cost) and only falls back to the raw entry count when a turn has
 * none of those yet — a user message the agent has not replied to.
 */
import { describe, expect, it } from "vitest";

import { turnNodeSummary } from "./turn-graph-node.tsx";

describe("turnNodeSummary", () => {
  it("falls back to the entry count when there is nothing else to report", () => {
    expect(
      turnNodeSummary({ cost: 0, entryCount: 1, tokens: 0, toolCallCount: 0 }),
    ).toBe("1 entry");
    expect(
      turnNodeSummary({ cost: 0, entryCount: 3, tokens: 0, toolCallCount: 0 }),
    ).toBe("3 entries");
  });

  it("prefers tool calls, tokens, and cost, in that order", () => {
    expect(
      turnNodeSummary({
        cost: 0.05,
        entryCount: 4,
        tokens: 1300,
        toolCallCount: 3,
      }),
    ).toBe("3 tools · 1.3k tokens · $0.050");
  });

  it("singularises a lone tool call", () => {
    expect(
      turnNodeSummary({ cost: 0, entryCount: 2, tokens: 0, toolCallCount: 1 }),
    ).toBe("1 tool");
  });

  it("omits a zero field rather than showing it as zero", () => {
    expect(
      turnNodeSummary({ cost: 0, entryCount: 2, tokens: 500, toolCallCount: 0 }),
    ).toBe("500 tokens");
  });
});
