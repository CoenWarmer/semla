/**
 * The property under test is "named entry resolves to the tip of its branch",
 * not "named entry resolves to itself" — a stale link must not truncate a
 * branch that has grown since it was shared. See
 * docs/plans/branching-sessions.md §6.
 */
import { describe, expect, it } from "vitest";

import { resolveLeafOverride } from "./session-leaf.ts";

type Entry = { id: string; parentId: string | null };

const linear: Entry[] = [
  { id: "a", parentId: null },
  { id: "b", parentId: "a" },
  { id: "c", parentId: "b" },
];

describe("resolveLeafOverride", () => {
  it("returns undefined when nothing was requested", () => {
    expect(resolveLeafOverride(linear, null)).toBeUndefined();
    expect(resolveLeafOverride(linear, undefined)).toBeUndefined();
  });

  it("returns the named entry when it is already the tip", () => {
    expect(resolveLeafOverride(linear, "c")).toBe("c");
  });

  it("walks forward to the current tip of the branch the entry sits on", () => {
    // The conversation continued past "a" since whoever holds a link to it
    // last looked. Resolving to "a" itself would truncate that growth.
    expect(resolveLeafOverride(linear, "a")).toBe("c");
  });

  it("takes the most recently appended child at a fork", () => {
    const branched: Entry[] = [
      { id: "a", parentId: null },
      { id: "b1", parentId: "a" },
      { id: "b2", parentId: "a" },
    ];

    expect(resolveLeafOverride(branched, "a")).toBe("b2");
  });

  it("falls back to undefined for an id the session does not recognise", () => {
    // A different session's id, or one a rewrite has since dropped.
    expect(resolveLeafOverride(linear, "nope")).toBeUndefined();
  });

  it("does not hang on a parent cycle", () => {
    const cyclic: Entry[] = [
      { id: "a", parentId: "b" },
      { id: "b", parentId: "a" },
    ];

    expect(() => resolveLeafOverride(cyclic, "a")).not.toThrow();
  });
});
