import { describe, expect, it } from "vitest";

import {
  activeCommitSha,
  BLANK_COMMIT_SELECTION,
} from "./review-artifact-commit.ts";

describe("activeCommitSha", () => {
  it("keeps the operator's own selection while its overNonce matches the target", () => {
    const own = { overNonce: 3, sha: "own-sha" };
    expect(activeCommitSha(own, { commitSha: "target-sha", nonce: 3 })).toBe(
      "own-sha",
    );
  });

  it("lets a newer target's commitSha win over a stale own selection", () => {
    const own = { overNonce: 1, sha: "own-sha" };
    expect(activeCommitSha(own, { commitSha: "target-sha", nonce: 2 })).toBe(
      "target-sha",
    );
  });

  it("yields null, not the stale own value, when a newer target names no commit", () => {
    const own = { overNonce: 1, sha: "own-sha" };
    expect(activeCommitSha(own, { commitSha: null, nonce: 2 })).toBeNull();
    expect(activeCommitSha(own, { nonce: 2 })).toBeNull();
  });

  it("treats a null target the same as nonce 0", () => {
    expect(activeCommitSha(BLANK_COMMIT_SELECTION, null)).toBeNull();
    expect(activeCommitSha({ overNonce: 0, sha: "s" }, null)).toBe("s");
  });
});
