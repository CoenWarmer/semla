import { describe, expect, it } from "vitest";

import {
  describeGitStatus,
  formatFetchAge,
  type GitStatus,
} from "./git-status-display";

const status = (over: Partial<GitStatus> = {}): GitStatus => ({
  branch: "main",
  head: "94ed760",
  base: "origin/main",
  ahead: 0,
  behind: 0,
  fetchedAt: Date.now(),
  fetching: false,
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

  it("dates the counts, so freshness is never assumed", () => {
    expect(describeGitStatus(status({ ahead: 1 }))?.title).toContain(
      "Fetched just now",
    );
    expect(
      describeGitStatus(status({ ahead: 1, fetchedAt: null }))?.title,
    ).toContain("never fetched");
  });

  it("says so while a fetch is running", () => {
    expect(
      describeGitStatus(status({ ahead: 1, fetching: true }))?.title,
    ).toContain("Fetching now");
  });
});

describe("formatFetchAge", () => {
  const now = Date.parse("2026-08-31T22:00:00Z");
  const ago = (ms: number) => formatFetchAge(now - ms, now);

  it("reads a recent fetch as just now", () => {
    expect(ago(0)).toBe("just now");
    expect(ago(44_000)).toBe("just now");
  });

  it("counts minutes, hours and days", () => {
    expect(ago(5 * 60_000)).toBe("5m ago");
    expect(ago(3 * 3_600_000)).toBe("3h ago");
    expect(ago(2 * 86_400_000)).toBe("2d ago");
  });

  it("never rounds a real gap down to zero minutes", () => {
    // 50s is past "just now" but floors to 0 minutes; "0m ago" reads as fresh.
    expect(ago(50_000)).toBe("1m ago");
  });

  it("says never when nothing has ever been fetched", () => {
    expect(formatFetchAge(null, now)).toBe("never fetched");
  });

  it("renders nothing without a project or a repository", () => {
    expect(describeGitStatus(undefined)).toBeNull();
    expect(describeGitStatus(null)).toBeNull();
    expect(describeGitStatus(status({ head: null }))).toBeNull();
  });
});
