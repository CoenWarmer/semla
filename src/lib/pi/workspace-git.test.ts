import { beforeEach, describe, expect, it, vi } from "vitest";

const projectsMock = vi.hoisted(() => vi.fn());
const readGitStatusMock = vi.hoisted(() => vi.fn());
const gitMock = vi.hoisted(() => vi.fn());
const refreshRemoteMock = vi.hoisted(() => vi.fn());

vi.mock("./workspace", () => ({ getWorkspaceProjects: projectsMock }));
vi.mock("./git-status", () => ({
  readGitStatus: readGitStatusMock,
  pickCanonicalRemote: (remotes: string[]) =>
    remotes.includes("upstream") ? "upstream" : (remotes[0] ?? null),
}));
vi.mock("./git", () => ({ git: gitMock }));
vi.mock("./git-fetch", () => ({ refreshRemote: refreshRemoteMock }));

const { getWorkspaceGitStatus, isWorkspaceProject, refreshProject } =
  await import("./workspace-git");

const status = (branch: string) => ({
  branch,
  head: "abc1234",
  base: "origin/main",
  ahead: 0,
  behind: 0,
  fetchedAt: null,
  fetching: false,
});

describe("getWorkspaceGitStatus", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    projectsMock.mockReset();
    readGitStatusMock.mockReset();
    projectsMock.mockResolvedValue([
      { name: "one", path: "/ws/one" },
      { name: "two", path: "/ws/two" },
    ]);
    readGitStatusMock.mockImplementation((path: string) =>
      Promise.resolve(status(path === "/ws/one" ? "main" : "feature")),
    );
    // Advance past any cache left by a previous test in this file.
    vi.advanceTimersByTime(10_000);
  });

  it("keys each project's status by path", async () => {
    const result = await getWorkspaceGitStatus();
    expect(result["/ws/one"].branch).toBe("main");
    expect(result["/ws/two"].branch).toBe("feature");
  });

  it("never fetches while reading the whole workspace", async () => {
    // Dozens of cards must not mean dozens of network connections.
    await getWorkspaceGitStatus();
    for (const call of readGitStatusMock.mock.calls) {
      expect(call[1]).toEqual({ fetch: false });
    }
  });

  it("serves repeat reads from cache", async () => {
    await getWorkspaceGitStatus();
    await getWorkspaceGitStatus();
    expect(readGitStatusMock).toHaveBeenCalledTimes(2); // two projects, once
  });
});

describe("isWorkspaceProject", () => {
  beforeEach(() => {
    projectsMock.mockReset();
    projectsMock.mockResolvedValue([{ name: "one", path: "/ws/one" }]);
  });

  it("accepts a listed project", async () => {
    await expect(isWorkspaceProject("/ws/one")).resolves.toBe(true);
  });

  it("rejects anything the workspace did not list", async () => {
    // The path arrives from a browser and the actions behind it write to a
    // repository, so only an already-listed project may be named.
    await expect(isWorkspaceProject("/etc")).resolves.toBe(false);
    await expect(isWorkspaceProject("/ws/one/../../tmp")).resolves.toBe(false);
    await expect(isWorkspaceProject("/ws/one/")).resolves.toBe(false);
    await expect(isWorkspaceProject("")).resolves.toBe(false);
  });
});

describe("refreshProject", () => {
  beforeEach(() => {
    gitMock.mockReset();
    refreshRemoteMock.mockReset();
    readGitStatusMock.mockReset();
    readGitStatusMock.mockResolvedValue({ ...status("main"), base: "upstream/main" });
  });

  it("fetches the canonical remote's branch, not the whole remote", async () => {
    gitMock.mockResolvedValue("origin\nupstream");
    refreshRemoteMock.mockReturnValue(true);
    await expect(refreshProject("/ws/one")).resolves.toBe(true);
    expect(refreshRemoteMock).toHaveBeenCalledWith("/ws/one", "upstream", "main");
  });

  it("reads without fetching while working out what to fetch", async () => {
    gitMock.mockResolvedValue("upstream");
    await refreshProject("/ws/one");
    expect(readGitStatusMock).toHaveBeenCalledWith("/ws/one", { fetch: false });
  });

  it("does nothing for a repository with no remotes", async () => {
    gitMock.mockResolvedValue(null);
    await expect(refreshProject("/ws/one")).resolves.toBe(false);
    expect(refreshRemoteMock).not.toHaveBeenCalled();
  });

  it("does nothing when there is no branch to compare against", async () => {
    gitMock.mockResolvedValue("upstream");
    readGitStatusMock.mockResolvedValue({ ...status("main"), base: null });
    await expect(refreshProject("/ws/one")).resolves.toBe(false);
    expect(refreshRemoteMock).not.toHaveBeenCalled();
  });
});
