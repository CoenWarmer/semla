/**
 * The property this pins: two branches of the same session must not share a
 * cache slot, and the default/live view must keep the key it always had —
 * see docs/plans/branching-sessions.md §4.
 */
import { describe, expect, it } from "vitest";

import { sessionMessagesQueryKey } from "./use-session-messages.ts";

describe("sessionMessagesQueryKey", () => {
  it("keeps the original two-part key for the default view", () => {
    expect(sessionMessagesQueryKey("s1")).toEqual(["session-messages", "s1"]);
    expect(sessionMessagesQueryKey("s1", null)).toEqual([
      "session-messages",
      "s1",
    ]);
    expect(sessionMessagesQueryKey("s1", undefined)).toEqual([
      "session-messages",
      "s1",
    ]);
  });

  it("adds the leaf as a third key segment when one is named", () => {
    expect(sessionMessagesQueryKey("s1", "entry-42")).toEqual([
      "session-messages",
      "s1",
      "entry-42",
    ]);
  });

  it("gives two different leaves two different keys", () => {
    const a = sessionMessagesQueryKey("s1", "a");
    const b = sessionMessagesQueryKey("s1", "b");
    expect(a).not.toEqual(b);
  });
});
