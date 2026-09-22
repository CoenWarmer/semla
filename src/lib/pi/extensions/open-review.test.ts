/**
 * The `open_review` tool's own logic: target resolution (already exercised
 * indirectly through the routes it shares helpers with) and, new here, the
 * `comment` parameter's validation and insertion.
 *
 * `review-service.ts` and `review-comment-store.ts` are mocked rather than
 * exercised for real — this is a unit test of the tool's own control flow
 * (which guard fires, what gets passed to the store), not an integration test
 * of git or Postgres.
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
  const mod = await import("./open-review");
  const tools: RegisteredTool[] = [];
  mod.default({ registerTool: (tool: RegisteredTool) => tools.push(tool) } as never);
  return tools[0]!;
}

const ctx = { sessionManager: { getSessionId: () => "session-1" } };

describe("open_review tool — comment parameter", () => {
  it("requires both path and line when a comment is given", async () => {
    const tool = await loadTool();

    await expect(
      tool.execute("call-1", { comment: { kind: "text", text: "hi" } }, undefined, undefined, ctx),
    ).rejects.toThrow(/requires both `path` and `line`/);

    await expect(
      tool.execute(
        "call-1",
        { comment: { kind: "text", text: "hi" }, path: "a.ts" },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow(/requires both `path` and `line`/);
  });

  it("rejects an endLine before line", async () => {
    const tool = await loadTool();

    await expect(
      tool.execute(
        "call-1",
        {
          comment: { endLine: 3, kind: "text", text: "hi" },
          line: 10,
          path: "a.ts",
        },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow(/endLine.*must not be less than/);
  });

  it("inserts the comment after resolving the target, keyed by the resolved path", async () => {
    resolveReviewTarget.mockResolvedValue({
      link: { path: "semla" },
      root: "/root",
    });
    resolveReviewFile.mockReturnValue("/root/src/a.ts");
    createReviewComment.mockResolvedValue({
      body: { kind: "markdown", markdown: "explanation" },
      createdAt: "2026-01-01T00:00:00Z",
      endLine: 12,
      filePath: "src/a.ts",
      id: "comment-1",
      projectPath: "semla",
      startLine: 10,
    });

    const tool = await loadTool();
    const result = await tool.execute(
      "call-1",
      {
        comment: { endLine: 12, kind: "markdown", text: "explanation" },
        line: 10,
        path: "src/a.ts",
        project: "semla",
      },
      undefined,
      undefined,
      ctx,
    );

    expect(createReviewComment).toHaveBeenCalledWith({
      body: { kind: "markdown", markdown: "explanation" },
      endLine: 12,
      filePath: "src/a.ts",
      projectPath: "semla",
      sessionId: "session-1",
      startLine: 10,
      toolCallId: "call-1",
    });
    expect((result.details as { comment: { id: string } }).comment.id).toBe("comment-1");
  });

  it("defaults endLine to line for a single-line comment", async () => {
    resolveReviewTarget.mockResolvedValue({
      link: { path: "semla" },
      root: "/root",
    });
    resolveReviewFile.mockReturnValue("/root/src/a.ts");
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
    await tool.execute(
      "call-1",
      { comment: { kind: "text", text: "hi" }, line: 5, path: "src/a.ts", project: "semla" },
      undefined,
      undefined,
      ctx,
    );

    expect(createReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({ endLine: 5, startLine: 5 }),
    );
  });

  it("does not insert a comment when none was given", async () => {
    resolveReviewTarget.mockResolvedValue({
      link: { path: "semla" },
      root: "/root",
    });
    resolveReviewFile.mockReturnValue("/root/src/a.ts");
    createReviewComment.mockClear();

    const tool = await loadTool();
    const result = await tool.execute(
      "call-1",
      { path: "src/a.ts", project: "semla" },
      undefined,
      undefined,
      ctx,
    );

    expect(createReviewComment).not.toHaveBeenCalled();
    expect((result.details as { comment?: unknown }).comment).toBeUndefined();
  });
});
