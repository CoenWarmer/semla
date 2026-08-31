import { describe, expect, it } from "vitest";

import { describeGitStatus, type GitStatus } from "./git-status-display";

const status = (over: Partial<GitStatus> = {}): GitStatus => ({
  branch: "main",
  head: "94ed760",
  base: "origin/main",
  ahead: 0,
  behind: 0,
  ...over,
});

describe("describeGitStatus", () => {
  it("shows the branch with no counters when up to date", () => {
    const label = describeGitStatus(status());
    expect(label?.ref).toBe("main");
    expect(label?.ahead).toBeNull();
    expect(label?.behind).toBeNull();
    expect(label?.title).toContain("up to date with origin/main");
  });

  it("counts commits ahead", () => {
    const label = describeGitStatus(status({ ahead: 187 }));
    expect(label?.ahead).toBe(187);
    expect(label?.behind).toBeNull();
    expect(label?.title).toContain("187 commits ahead of origin/main");
  });

  it("counts divergence in both directions", () => {
    const label = describeGitStatus(status({ ahead: 2, behind: 3 }));
    expect(label?.ahead).toBe(2);
    expect(label?.behind).toBe(3);
    expect(label?.title).toContain("2 commits ahead of and 3 commits behind");
  });

  it("says commit, not commits, for one", () => {
    expect(describeGitStatus(status({ ahead: 1 }))?.title).toContain(
      "1 commit ahead",
    );
  });

  it("names the sha when HEAD is detached", () => {
    const label = describeGitStatus(status({ branch: null, ahead: 4 }));
    expect(label?.ref).toBe("94ed760");
    expect(label?.title).toContain("Detached at 94ed760");
  });

  it("drops the counters when there is no canonical branch", () => {
    const label = describeGitStatus(status({ base: null, ahead: 9, behind: 9 }));
    expect(label?.ref).toBe("main");
    expect(label?.ahead).toBeNull();
    expect(label?.behind).toBeNull();
    expect(label?.title).toContain("no canonical branch to compare against");
  });

  it("says the counts are only as fresh as the last fetch", () => {
    // No fetch is run off a UI poll, so the tooltip must not imply otherwise.
    expect(describeGitStatus(status({ ahead: 1 }))?.title).toContain(
      "last fetch",
    );
  });

  it("renders nothing without a project or a repository", () => {
    expect(describeGitStatus(undefined)).toBeNull();
    expect(describeGitStatus(null)).toBeNull();
    expect(describeGitStatus(status({ head: null }))).toBeNull();
  });
});
