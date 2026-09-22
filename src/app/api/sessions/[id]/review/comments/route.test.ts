import { describe, expect, it, vi } from "vitest";

const resolveReviewTarget = vi.fn();
const listReviewComments = vi.fn();
const createReviewComment = vi.fn();

vi.mock("@/lib/pi/review/review-service", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/pi/review/review-service")>();
  return {
    errorFailure: original.errorFailure,
    messageFailure: original.messageFailure,
    resolveReviewTarget: (...args: unknown[]) => resolveReviewTarget(...args),
    withReviewTarget: async (
      options: { onFailure: (reason: "project" | "path") => unknown; project?: string | null; sessionId: string },
      handler: (target: unknown) => unknown,
    ) => {
      const target = await resolveReviewTarget(options.sessionId, options.project ?? null);
      if (!target) return options.onFailure("project");
      return handler(target);
    },
  };
});
vi.mock("@/lib/pi/review/review-comment-store", () => ({
  createReviewComment: (...args: unknown[]) => createReviewComment(...args),
  listReviewComments: (...args: unknown[]) => listReviewComments(...args),
}));

import { GET, POST } from "./route";

const params = () => Promise.resolve({ id: "session-1" });

describe("GET /api/sessions/[id]/review/comments", () => {
  it("requires a path", async () => {
    const res = await GET(
      new Request("http://x/?project=semla"),
      { params: params() },
    );
    expect(res.status).toBe(400);
  });

  it("refuses a project this session is not linked to", async () => {
    resolveReviewTarget.mockResolvedValue(null);

    const res = await GET(
      new Request("http://x/?project=other&path=a.ts"),
      { params: params() },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/not a project/i);
  });

  it("lists live comments for the resolved project", async () => {
    resolveReviewTarget.mockResolvedValue({ link: { path: "semla" }, root: "/root" });
    listReviewComments.mockResolvedValue([
      {
        body: { kind: "text", text: "hi" },
        createdAt: "2026-01-01T00:00:00Z",
        endLine: 5,
        filePath: "a.ts",
        id: "c1",
        projectPath: "semla",
        startLine: 5,
      },
    ]);

    const res = await GET(
      new Request("http://x/?project=semla&path=a.ts"),
      { params: params() },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.comments).toHaveLength(1);
    expect(listReviewComments).toHaveBeenCalledWith("session-1", "semla", "a.ts");
  });
});

describe("POST /api/sessions/[id]/review/comments", () => {
  const request = (body: unknown) =>
    new Request("http://x/", { body: JSON.stringify(body), method: "POST" });

  it("rejects a missing body field", async () => {
    const res = await POST(request({ path: "a.ts", startLine: 1 }), { params: params() });
    expect(res.status).toBe(400);
  });

  it("rejects endLine before startLine", async () => {
    const res = await POST(
      request({
        body: { kind: "text", text: "hi" },
        endLine: 1,
        path: "a.ts",
        startLine: 5,
      }),
      { params: params() },
    );
    expect(res.status).toBe(400);
  });

  it("creates a comment for a resolved project", async () => {
    resolveReviewTarget.mockResolvedValue({ link: { path: "semla" }, root: "/root" });
    createReviewComment.mockResolvedValue({
      body: { kind: "text", text: "hi" },
      createdAt: "2026-01-01T00:00:00Z",
      endLine: 5,
      filePath: "a.ts",
      id: "c1",
      projectPath: "semla",
      startLine: 5,
    });

    const res = await POST(
      request({
        body: { kind: "text", text: "hi" },
        endLine: 5,
        path: "a.ts",
        project: "semla",
        startLine: 5,
      }),
      { params: params() },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.comment.id).toBe("c1");
    expect(createReviewComment).toHaveBeenCalledWith({
      body: { kind: "text", text: "hi" },
      endLine: 5,
      filePath: "a.ts",
      projectPath: "semla",
      sessionId: "session-1",
      startLine: 5,
      toolCallId: null,
    });
  });
});
