import { beforeEach, describe, expect, it, vi } from "vitest";

const gitMock = vi.hoisted(() => vi.fn());
const fetchNowMock = vi.hoisted(() => vi.fn());

vi.mock("./git", () => ({ git: gitMock }));
vi.mock("./git-fetch", () => ({
  fetchNow: fetchNowMock,
  refreshRemote: vi.fn(),
  lastFetchedAt: vi.fn().mockResolvedValue(null),
}));

const {
  fetchCanonical,
  parseAheadBehind,
  parseRemoteHead,
  pickCanonicalRemote,
} = await import("./git-status");

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

describe("fetchCanonical", () => {
  beforeEach(() => {
    gitMock.mockReset();
    fetchNowMock.mockReset();
    fetchNowMock.mockResolvedValue(undefined);
  });

  /** Answer `git remote`, then the default-branch lookup. */
  const repoWith = (remotes: string, head: string | null) =>
    gitMock.mockImplementation((_p: string, args: string[]) => {
      if (args[0] === "remote") return Promise.resolve(remotes);
      if (args[0] === "symbolic-ref") return Promise.resolve(head);
      return Promise.resolve(null);
    });

  it("fetches the fork's upstream branch, not the fork", async () => {
    repoWith("origin\nupstream", "refs/remotes/upstream/main");
    await fetchCanonical("/repo");
    expect(fetchNowMock).toHaveBeenCalledWith("/repo", "upstream", "main");
  });

  it("falls back to origin when there is no fork", async () => {
    repoWith("origin", "refs/remotes/origin/main");
    await fetchCanonical("/repo");
    expect(fetchNowMock).toHaveBeenCalledWith("/repo", "origin", "main");
  });

  it("keeps slashes in a branch name", async () => {
    repoWith("origin", "refs/remotes/origin/release/2.x");
    await fetchCanonical("/repo");
    expect(fetchNowMock).toHaveBeenCalledWith("/repo", "origin", "release/2.x");
  });

  it("does nothing without a remote", async () => {
    repoWith("", null);
    await fetchCanonical("/repo");
    expect(fetchNowMock).not.toHaveBeenCalled();
  });

  it("does nothing when no default branch can be found", async () => {
    // No recorded HEAD and neither main nor master resolves.
    repoWith("origin", null);
    await fetchCanonical("/repo");
    expect(fetchNowMock).not.toHaveBeenCalled();
  });
});
