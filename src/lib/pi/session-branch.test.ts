/**
 * Two cases and one refusal.
 *
 * The refusal matters most: if an unknown entry id quietly fell back to
 * appending at the end, the edited prompt would be answered with the original
 * still sitting in the model's context. That failure looks like success from the
 * outside, which is the worst shape a bug can take here.
 */
import { describe, expect, it, vi } from "vitest";

import {
  applyBranchTarget,
  EntryNotFoundError,
  resolveBranchTarget,
} from "./session-branch.ts";

const entries = [
  { id: "a", parentId: null },
  { id: "b", parentId: "a" },
  { id: "c", parentId: "b" },
];

describe("resolveBranchTarget", () => {
  it("branches from the parent of the edited entry", () => {
    expect(resolveBranchTarget(entries, "c")).toEqual({
      kind: "entry",
      parentId: "b",
    });
  });

  it("resets to root when the edited entry is the first message", () => {
    // Pi: "Use this when navigating to re-edit the first user message."
    expect(resolveBranchTarget(entries, "a")).toEqual({ kind: "root" });
  });

  it("treats an undefined parent the same as a null one", () => {
    expect(resolveBranchTarget([{ id: "only" }], "only")).toEqual({ kind: "root" });
  });

  it("refuses an entry it cannot find", () => {
    expect(() => resolveBranchTarget(entries, "nope")).toThrow(EntryNotFoundError);
    expect(() => resolveBranchTarget(entries, "nope")).toThrow(/nope/);
  });
});

describe("applyBranchTarget", () => {
  it("moves the leaf to the parent for a mid-conversation edit", () => {
    const mover = { branch: vi.fn(), resetLeaf: vi.fn() };

    applyBranchTarget(mover, { kind: "entry", parentId: "b" });

    expect(mover.branch).toHaveBeenCalledWith("b");
    expect(mover.resetLeaf).not.toHaveBeenCalled();
  });

  it("resets the leaf for the first message", () => {
    const mover = { branch: vi.fn(), resetLeaf: vi.fn() };

    applyBranchTarget(mover, { kind: "root" });

    expect(mover.resetLeaf).toHaveBeenCalled();
    expect(mover.branch).not.toHaveBeenCalled();
  });
});
