/**
 * The `place_review_comments` tool's own control flow: per-entry validation,
 * best-effort batching, and what gets passed to the store.
 *
 * Same mocking strategy as open-review.test.ts: review-service.ts and
 * review-comment-store.ts are mocked, so this exercises the tool's own
 * logic rather than git or Postgres.
 */
import { describe, expect, it, vi } from "vitest";

const resolveReviewTarget = vi.fn();
const resolveReviewFile = vi.fn();
const createReviewComment = vi.fn();
const sessionProjects = vi.fn(async (..._args: unknown[]) => [] as unknown[]);

vi.mock("@/lib/pi/review/review-service", () => ({
  resolveReviewFile: (...args: unknown[]) => resolveReviewFile(...args),
  resolveReviewTarget: (...args: unknown[]) => resolveReviewTarget(...args),
}));
vi.mock("@/lib/pi/review/review-comment-store", () => ({
  createReviewComment: (...args: unknown[]) => createReviewComment(...args),
}));
vi.mock("@/lib/pi/session/session-project", () => ({
  sessionProjects: (...args: unknown[]) => sessionProjects(...args),
}));
vi.mock("@/lib/pi/workspace/file-browser", () => ({
  toRelativePath: (_root: string, absolute: string) => absolute.replace(/^\/root\//, ""),
}));

type RegisteredTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: unknown,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<{ content: unknown[]; details: unknown }>;
};

async function loadTool(): Promise<RegisteredTool> {
  const mod = await import("./place-review-comments");
  const tools: RegisteredTool[] = [];
  mod.default({ registerTool: (tool: RegisteredTool) => tools.push(tool) } as never);
  return tools[0]!;
}

const ctx = { sessionManager: { getSessionId: () => "session-1" } };

type EntryResult =
  | { index: number; ok: true; comment: { id: string } }
  | { index: number; ok: false; path: string; error: string };

describe("place_review_comments tool", () => {
  it("rejects an endLine before line for that entry without touching others", async () => {
    resolveReviewTarget.mockResolvedValue({ link: { path: "semla" }, root: "/root" });
    resolveReviewFile.mockReturnValue("/root/src/a.ts");
    createReviewComment.mockResolvedValue({
      body: { kind: "text", text: "hi" },
      createdAt: "2026-01-01T00:00:00Z",
      endLine: 5,
      filePath: "src/a.ts",
      id: "comment-1",
      projectPath: "semla",
      startLine: 5,
    });

    const tool = await loadTool();
    const result = await tool.execute(
      "call-1",
      {
        comments: [
          { comment: { kind: "text", text: "bad" }, endLine: 3, line: 10, path: "src/bad.ts" },
          { comment: { kind: "text", text: "hi" }, line: 5, path: "src/a.ts", project: "semla" },
        ],
      },
      undefined,
      undefined,
      ctx,
    );

    const results = (result.details as { results: EntryResult[] }).results;
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ index: 0, ok: false });
    expect((results[0] as { error: string }).error).toMatch(/endLine.*must not be less than/);
    expect(results[1]).toMatchObject({ index: 1, ok: true });
  });

  it("refuses an entry whose project is not linked, without failing the others", async () => {
    resolveReviewTarget.mockImplementation(async (_sessionId: string, project: string | null) =>
      project === "other" ? null : { link: { path: "semla" }, root: "/root" },
    );
    resolveReviewFile.mockReturnValue("/root/src/a.ts");
    sessionProjects.mockResolvedValue([{ path: "semla" }]);
    createReviewComment.mockResolvedValue({
      body: { kind: "text", text: "hi" },
      createdAt: "2026-01-01T00:00:00Z",
      endLine: 5,
      filePath: "src/a.ts",
      id: "comment-2",
      projectPath: "semla",
      startLine: 5,
    });

    const tool = await loadTool();
    const result = await tool.execute(
      "call-1",
      {
        comments: [
          { comment: { kind: "text", text: "no" }, line: 1, path: "src/x.ts", project: "other" },
          { comment: { kind: "text", text: "hi" }, line: 5, path: "src/a.ts", project: "semla" },
        ],
      },
      undefined,
      undefined,
      ctx,
    );

    const results = (result.details as { results: EntryResult[] }).results;
    expect(results[0]).toMatchObject({ index: 0, ok: false });
    expect((results[0] as { error: string }).error).toMatch(/not a project this session is linked to/);
    expect(results[1]).toMatchObject({ index: 1, ok: true });
  });

  it("refuses an entry whose path escapes the project, without failing the others", async () => {
    resolveReviewTarget.mockResolvedValue({ link: { path: "semla" }, root: "/root" });
    resolveReviewFile.mockImplementation((_target: unknown, path: string) =>
      path === "../escape.ts" ? null : "/root/src/a.ts",
    );
    createReviewComment.mockResolvedValue({
      body: { kind: "text", text: "hi" },
      createdAt: "2026-01-01T00:00:00Z",
      endLine: 5,
      filePath: "src/a.ts",
      id: "comment-3",
      projectPath: "semla",
      startLine: 5,
    });

    const tool = await loadTool();
    const result = await tool.execute(
      "call-1",
      {
        comments: [
          { comment: { kind: "text", text: "no" }, line: 1, path: "../escape.ts" },
          { comment: { kind: "text", text: "hi" }, line: 5, path: "src/a.ts" },
        ],
      },
      undefined,
      undefined,
      ctx,
    );

    const results = (result.details as { results: EntryResult[] }).results;
    expect(results[0]).toMatchObject({ index: 0, ok: false });
    expect((results[0] as { error: string }).error).toMatch(/does not resolve inside/);
    expect(results[1]).toMatchObject({ index: 1, ok: true });
  });

  it("resolves each entry's project independently, caching repeated lookups", async () => {
    resolveReviewTarget.mockImplementation(async (_sessionId: string, project: string | null) => ({
      link: { path: project ?? "anchor" },
      root: "/root",
    }));
    resolveReviewFile.mockReturnValue("/root/src/a.ts");
    createReviewComment.mockImplementation(async (input: { projectPath: string }) => ({
      body: { kind: "text", text: "hi" },
      createdAt: "2026-01-01T00:00:00Z",
      endLine: 1,
      filePath: "src/a.ts",
      id: `comment-${input.projectPath}`,
      projectPath: input.projectPath,
      startLine: 1,
    }));

    const tool = await loadTool();
    const result = await tool.execute(
      "call-1",
      {
        comments: [
          { comment: { kind: "text", text: "a" }, line: 1, path: "src/a.ts", project: "one" },
          { comment: { kind: "text", text: "b" }, line: 1, path: "src/a.ts", project: "two" },
          { comment: { kind: "text", text: "c" }, line: 1, path: "src/a.ts", project: "one" },
        ],
      },
      undefined,
      undefined,
      ctx,
    );

    // Two distinct projects across three entries: two resolutions, not three.
    expect(resolveReviewTarget).toHaveBeenCalledTimes(2);
    const results = (result.details as { results: EntryResult[] }).results;
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("reports a store failure for one entry without losing the others", async () => {
    resolveReviewTarget.mockResolvedValue({ link: { path: "semla" }, root: "/root" });
    resolveReviewFile.mockReturnValue("/root/src/a.ts");
    createReviewComment
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce({
        body: { kind: "text", text: "hi" },
        createdAt: "2026-01-01T00:00:00Z",
        endLine: 1,
        filePath: "src/a.ts",
        id: "comment-4",
        projectPath: "semla",
        startLine: 1,
      });

    const tool = await loadTool();
    const result = await tool.execute(
      "call-1",
      {
        comments: [
          { comment: { kind: "text", text: "fails" }, line: 1, path: "src/a.ts" },
          { comment: { kind: "text", text: "ok" }, line: 1, path: "src/a.ts" },
        ],
      },
      undefined,
      undefined,
      ctx,
    );

    const results = (result.details as { results: EntryResult[] }).results;
    expect(results[0]).toMatchObject({ index: 0, ok: false, error: "db down" });
    expect(results[1]).toMatchObject({ index: 1, ok: true });
  });
});
