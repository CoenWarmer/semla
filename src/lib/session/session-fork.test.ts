/**
 * The property this exists for: showing "forked here, nothing has diverged
 * yet" without pretending anything after the fork point is gone. See
 * docs/plans/branching-sessions.md §3.
 */
import { describe, expect, it } from "vitest";

import { truncateAtMessage } from "./session-fork.ts";

const messages = [{ id: "a" }, { id: "b" }, { id: "c" }];

describe("truncateAtMessage", () => {
  it("returns everything when nothing is forked", () => {
    expect(truncateAtMessage(messages, null)).toEqual(messages);
    expect(truncateAtMessage(messages, undefined)).toEqual(messages);
  });

  it("keeps the forked message itself and drops what came after", () => {
    expect(truncateAtMessage(messages, "b").map((m) => m.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("keeps everything when forked at the last message", () => {
    expect(truncateAtMessage(messages, "c").map((m) => m.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("falls back to showing everything for a fork target not in the list", () => {
    // Scrolled out of what is loaded, or stale — the same fallback the server
    // applies to an unresolvable leaf.
    expect(truncateAtMessage(messages, "gone")).toEqual(messages);
  });

  it("returns a new array rather than the original reference", () => {
    // Callers memoise on this; returning the same array back for the
    // no-op case would be fine, but a fresh one for the truncated case must
    // not alias `messages` so that later mutation of one doesn't leak.
    expect(truncateAtMessage(messages, null)).not.toBe(messages);
  });
});
