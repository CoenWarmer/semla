import { beforeEach, describe, expect, it, vi } from "vitest";

const projectsMock = vi.hoisted(() => vi.fn());
const readGitStatusMock = vi.hoisted(() => vi.fn());
const fetchCanonicalMock = vi.hoisted(() => vi.fn());

vi.mock("./workspace", () => ({ getWorkspaceProjects: projectsMock }));
vi.mock("./git-status", () => ({
  readGitStatus: readGitStatusMock,
  fetchCanonical: fetchCanonicalMock,
}));

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
    vi.useFakeTimers();
    fetchCanonicalMock.mockReset();
    fetchCanonicalMock.mockResolvedValue(undefined);
    projectsMock.mockReset();
    readGitStatusMock.mockReset();
    projectsMock.mockResolvedValue([{ name: "one", path: "/ws/one" }]);
    readGitStatusMock.mockResolvedValue(status("main"));
    vi.advanceTimersByTime(10_000);
  });

  it("waits for the fetch", async () => {
    await refreshProject("/ws/one");
    expect(fetchCanonicalMock).toHaveBeenCalledWith("/ws/one");
  });

  it("drops the cache so the next read sees the new refs", async () => {
    await getWorkspaceGitStatus();
    readGitStatusMock.mockClear();

    await getWorkspaceGitStatus(); // cached — no re-read
    expect(readGitStatusMock).not.toHaveBeenCalled();

    await refreshProject("/ws/one");
    await getWorkspaceGitStatus();
    expect(readGitStatusMock).toHaveBeenCalled();
  });
});
