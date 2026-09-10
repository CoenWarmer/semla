import { describe, expect, it } from "vitest";

import { turnForRun } from "./subagent-accesses.ts";
import type { TimelineTurn } from "./access-types.ts";

const turns: TimelineTurn[] = [
  { at: "2026-01-01T10:00:00.000Z", id: "u1" },
  { at: "2026-01-01T11:00:00.000Z", id: "u2" },
  { at: "2026-01-01T12:00:00.000Z", id: "u3" },
];

describe("turnForRun", () => {
  it("attributes a run to the turn that was in progress when it started", () => {
    expect(turnForRun(turns, "2026-01-01T11:30:00.000Z")).toBe("u2");
  });

  it("attributes a run started exactly on a turn boundary to that turn", () => {
    expect(turnForRun(turns, "2026-01-01T11:00:00.000Z")).toBe("u2");
  });

  it("attributes a run predating every prompt to the synthetic root", () => {
    expect(turnForRun(turns, "2025-12-31T00:00:00.000Z")).toBe("\u2039root\u203a");
  });

  it("attributes a run with no recorded start to the most recent turn", () => {
    // Ordinary for a run file written before `created_at` was recorded. The
    // latest turn is the better guess than the first, and better than dropping
    // the subagent's reads entirely.
    expect(turnForRun(turns, null)).toBe("u3");
  });

  it("falls back to the root when there are no turns at all", () => {
    expect(turnForRun([], "2026-01-01T11:00:00.000Z")).toBe("\u2039root\u203a");
  });

  it("skips an undated turn rather than stopping at it", () => {
    // An entry that never carried a timestamp. Treating it as the end of the
    // scan would orphan every subagent that ran after it.
    expect(
      turnForRun([{ at: "", id: "u0" }, ...turns], "2026-01-01T11:30:00.000Z"),
    ).toBe("u2");
  });
});
