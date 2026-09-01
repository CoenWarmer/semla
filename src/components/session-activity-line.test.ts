import { describe, expect, it } from "vitest";

import { activityLabel } from "@/components/session-activity-line";

describe("activityLabel", () => {
  it("names the tool being run", () => {
    expect(activityLabel("code_map", false)).toBe("Running code_map…");
  });

  it("names the tool even once prose has started arriving", () => {
    // The case the old gating made unreachable: streamingText is not cleared
    // when a tool begins, so a tool call after any text showed nothing at all.
    expect(activityLabel("code_map", true)).toBe("Running code_map…");
  });

  it("is thinking before anything comes back", () => {
    expect(activityLabel(undefined, false)).toBe("Thinking…");
  });

  it("is responding once text is streaming, not still thinking", () => {
    expect(activityLabel(undefined, true)).toBe("Responding…");
  });
});
