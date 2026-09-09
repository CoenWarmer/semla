/**
 * The opt-in route.
 *
 * The assertions that matter are about the path check. This endpoint takes a
 * path from a request body and hands it to a filesystem walk and a directory
 * removal, so it validates against the set of projects the workspace scanner
 * actually found — a whitelist, which does not have to anticipate the attack —
 * rather than filtering for `..` and hoping.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api-helpers", async () => ({
  requireUser: vi.fn(async () => ({ id: "local" })),
  handleRouteError: (_error: unknown, message: string) =>
    Response.json({ error: message }, { status: 500 }),
}));

const getWorkspaceProjects = vi.fn();
vi.mock("@/lib/pi/workspace", () => ({
  getWorkspaceProjects: () => getWorkspaceProjects(),
}));

const startIndexRun = vi.fn();
const isIndexRunning = vi.fn((_path: string) => false);
vi.mock("@/lib/code-index/index-runs", () => ({
  startIndexRun: (path: string) => startIndexRun(path),
  isIndexRunning: (path: string) => isIndexRunning(path),
}));

const drop = vi.fn(async () => {});
vi.mock("@/lib/code-index/store/local", () => ({
  createLocalVectorStore: () => ({ drop }),
}));

const getProjectIndexStatuses = vi.fn();
vi.mock("@/lib/code-index/status", () => ({
  getProjectIndexStatuses: () => getProjectIndexStatuses(),
}));

const { DELETE, GET, POST } = await import("./route");

function request(body: unknown): Request {
  return new Request("http://localhost/api/code-index", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getWorkspaceProjects.mockResolvedValue([
    { name: "semla", path: "/Users/dev/semla", branch: "main", lastCommitAt: null, stalenessText: "" },
  ]);
  isIndexRunning.mockReturnValue(false);
  startIndexRun.mockReturnValue({ error: null, report: null, finishedAt: null });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/code-index", () => {
  it("lists project index status", async () => {
    getProjectIndexStatuses.mockResolvedValue([
      { name: "semla", path: "/Users/dev/semla", indexed: true, chunks: 97, model: "m", updated: "now", run: null },
    ]);

    const data = (await (await GET()).json()) as { projects: unknown[] };
    expect(data.projects).toHaveLength(1);
  });
});

describe("POST /api/code-index", () => {
  it("starts a run for a known project", async () => {
    const response = await POST(request({ path: "/Users/dev/semla" }));

    expect(response.status).toBe(202);
    expect(startIndexRun).toHaveBeenCalledWith("/Users/dev/semla");
    expect(await response.json()).toMatchObject({ started: true });
  });

  it("refuses a path that is not a workspace project", async () => {
    const response = await POST(request({ path: "/etc" }));

    expect(response.status).toBe(400);
    expect(startIndexRun).not.toHaveBeenCalled();
  });

  it("refuses a traversal that resembles a known project", async () => {
    const response = await POST(request({ path: "/Users/dev/semla/../../../etc" }));

    expect(response.status).toBe(400);
    expect(startIndexRun).not.toHaveBeenCalled();
  });

  it("refuses a missing or non-string path", async () => {
    expect((await POST(request({}))).status).toBe(400);
    expect((await POST(request({ path: 42 }))).status).toBe(400);
    expect(startIndexRun).not.toHaveBeenCalled();
  });

  it("says when a run was already in flight rather than pretending it started one", async () => {
    isIndexRunning.mockReturnValue(true);

    const data = (await (await POST(request({ path: "/Users/dev/semla" }))).json()) as {
      started: boolean;
      alreadyRunning: boolean;
    };

    expect(data).toEqual({ started: false, alreadyRunning: true, path: "/Users/dev/semla" });
  });

  it("reports a missing credential as a conflict, not a server fault", async () => {
    startIndexRun.mockReturnValue({
      error: "No embedding credential is configured.",
      report: null,
      finishedAt: Date.now(),
    });

    const response = await POST(request({ path: "/Users/dev/semla" }));
    expect(response.status).toBe(409);
  });
});

describe("DELETE /api/code-index", () => {
  it("drops a known project's index", async () => {
    const response = await DELETE(request({ path: "/Users/dev/semla" }));

    expect(response.status).toBe(200);
    expect(drop).toHaveBeenCalledOnce();
  });

  it("refuses an unknown path", async () => {
    expect((await DELETE(request({ path: "/etc" }))).status).toBe(400);
    expect(drop).not.toHaveBeenCalled();
  });

  /**
   * Removing the directory a run is writing into leaves it writing to nothing
   * and reporting success.
   */
  it("refuses while a run is in progress", async () => {
    isIndexRunning.mockReturnValue(true);

    const response = await DELETE(request({ path: "/Users/dev/semla" }));

    expect(response.status).toBe(409);
    expect(drop).not.toHaveBeenCalled();
  });
});
