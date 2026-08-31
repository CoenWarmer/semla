import { describe, expect, it } from "vitest";

import {
  parseAheadBehind,
  parseRemoteHead,
  pickCanonicalRemote,
} from "./git-status";

describe("parseAheadBehind", () => {
  it("reads the base count first, as --left-right prints it", () => {
    // `git rev-list --left-right --count origin/main...HEAD` → behind, ahead.
    expect(parseAheadBehind("0\t187")).toEqual({ behind: 0, ahead: 187 });
    expect(parseAheadBehind("3\t2")).toEqual({ behind: 3, ahead: 2 });
  });

  it("tolerates spaces instead of a tab", () => {
    expect(parseAheadBehind("  4   5  ")).toEqual({ behind: 4, ahead: 5 });
  });

  it("returns null when git said nothing or something unexpected", () => {
    expect(parseAheadBehind(null)).toBeNull();
    expect(parseAheadBehind("")).toBeNull();
    expect(parseAheadBehind("fatal: bad revision")).toBeNull();
    expect(parseAheadBehind("2")).toBeNull();
  });
});

describe("parseRemoteHead", () => {
  it("strips the ref prefix to leave a comparable name", () => {
    expect(parseRemoteHead("refs/remotes/origin/HEAD")).toBe("origin/HEAD");
    expect(parseRemoteHead("refs/remotes/origin/main")).toBe("origin/main");
  });

  it("returns null when origin has no default branch recorded", () => {
    expect(parseRemoteHead(null)).toBeNull();
    expect(parseRemoteHead("")).toBeNull();
    expect(parseRemoteHead("refs/heads/main")).toBeNull();
  });
});

describe("pickCanonicalRemote", () => {
  it("prefers the fork's upstream over the fork itself", () => {
    // origin is your fork, upstream is what it was forked from.
    expect(pickCanonicalRemote(["origin", "upstream"])).toBe("upstream");
  });

  it("uses origin when there is no fork", () => {
    expect(pickCanonicalRemote(["origin"])).toBe("origin");
  });

  it("falls back to whatever single remote exists", () => {
    expect(pickCanonicalRemote(["fork"])).toBe("fork");
  });

  it("returns null for a repository with no remotes", () => {
    expect(pickCanonicalRemote([])).toBeNull();
  });
});
