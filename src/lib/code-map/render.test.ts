/**
 * What the agent reads is what the agent will repeat. So the assertions here are
 * about honesty rather than formatting: that locations are carried through, and
 * that a bounded or partially-resolved map says so loudly enough that an
 * explanation built on it cannot present itself as complete.
 */
import { describe, expect, it } from "vitest";

import { describeBoundary, renderCodeMapText } from "./render.ts";
import type { CodeMap } from "./types.ts";

const base: CodeMap = {
  depth: 2,
  edges: [{ from: "a", kind: "call", sites: [12, 30], to: "b" }],
  nodes: [
    {
      container: null,
      external: false,
      file: "src/a.ts",
      id: "a",
      kind: "function",
      line: 4,
      name: "caller",
    },
    {
      container: "Runner",
      external: false,
      file: "src/b.ts",
      id: "b",
      kind: "method",
      line: 9,
      name: "callee",
    },
  ],
  root: "a",
  truncated: false,
  unresolved: [],
};

describe("renderCodeMapText", () => {
  it("cites the callee's location and the lines the call is on", () => {
    const text = renderCodeMapText(base);

    expect(text).toContain("src/b.ts:9");
    expect(text).toContain("L12, L30");
  });

  it("qualifies a method with its class", () => {
    expect(renderCodeMapText(base)).toContain("Runner.callee");
  });

  it("distinguishes construction from calling", () => {
    const text = renderCodeMapText({
      ...base,
      edges: [{ from: "a", kind: "new", sites: [7], to: "b" }],
    });

    expect(text).toContain("constructs");
  });

  it("says a bounded map is bounded", () => {
    const text = renderCodeMapText({ ...base, truncated: true });

    expect(text).toContain("Bounded");
    expect(text).toContain("do not describe this as the complete call graph");
  });

  it("says nothing about bounds when the map is whole", () => {
    expect(renderCodeMapText(base)).not.toContain("Bounded");
    expect(describeBoundary(base)).toBeNull();
  });

  it("reports unresolved calls rather than hiding them", () => {
    const text = renderCodeMapText({
      ...base,
      unresolved: [
        { from: "a", line: 21, name: "handler", reason: "no symbol at the call site" },
      ],
    });

    expect(text).toContain("Not resolved (1)");
    expect(text).toContain("handler");
    expect(text).toContain("L21");
  });

  it("caps a long unresolved list but admits how many it dropped", () => {
    const text = renderCodeMapText({
      ...base,
      unresolved: Array.from({ length: 25 }, (_, index) => ({
        from: "a",
        line: index + 1,
        name: `fn${index}`,
        reason: "dynamic",
      })),
    });

    expect(text).toContain("Not resolved (25)");
    expect(text).toContain("and 5 more");
  });
});
