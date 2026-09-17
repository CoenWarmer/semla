import { describe, expect, it } from "vitest";

import { detectPullRequests } from "@/lib/pi/artifacts/pr-detect";

describe("detectPullRequests", () => {
  it("detects a PR from gh pr create output", () => {
    const result = detectPullRequests({
      command: "gh pr create --title x --body y",
      output: "https://github.com/owner/repo/pull/412",
    });
    expect(result).toEqual([{ number: 412, repo: "owner/repo", url: "https://github.com/owner/repo/pull/412" }]);
  });

  it("detects a url embedded in the command itself", () => {
    const result = detectPullRequests({
      command: "gh pr create ... && echo https://github.com/owner/repo/pull/9",
      output: "",
    });
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(9);
  });

  it("returns [] for gh pr list output, even with urls in it", () => {
    const result = detectPullRequests({
      command: "gh pr list",
      output: "https://github.com/owner/repo/pull/1",
    });
    expect(result).toEqual([]);
  });

  it("returns [] for gh pr create with no url in its output", () => {
    const result = detectPullRequests({
      command: "gh pr create --title x",
      output: "Creating pull request...",
    });
    expect(result).toEqual([]);
  });

  it("returns two, deduped, in order", () => {
    const result = detectPullRequests({
      command: "gh pr create",
      output:
        "https://github.com/owner/repo/pull/1\nhttps://github.com/owner/repo/pull/2\nhttps://github.com/owner/repo/pull/1",
    });
    expect(result.map((r) => r.number)).toEqual([1, 2]);
  });

  it("does not match a non-github host", () => {
    const result = detectPullRequests({
      command: "gh pr create",
      output: "https://gitlab.example.com/owner/repo/pull/1",
    });
    expect(result).toEqual([]);
  });

  it("returns [] for a null command or output", () => {
    expect(detectPullRequests({ command: null, output: "https://github.com/o/r/pull/1" })).toEqual([]);
    expect(detectPullRequests({ command: "gh pr create", output: null })).toEqual([]);
  });
});
