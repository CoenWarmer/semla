import { describe, expect, it, vi } from "vitest";

const dismissReviewComment = vi.fn();

vi.mock("@/lib/pi/review/review-comment-store", () => ({
  dismissReviewComment: (...args: unknown[]) => dismissReviewComment(...args),
}));

import { PATCH } from "./route";

describe("PATCH /api/sessions/[id]/review/comments/[commentId]", () => {
  it("dismisses the comment, scoped by session and comment id", async () => {
    dismissReviewComment.mockResolvedValue(undefined);

    const res = await PATCH(new Request("http://x/", { method: "PATCH" }), {
      params: Promise.resolve({ commentId: "comment-1", id: "session-1" }),
    });

    expect(res.status).toBe(200);
    expect(dismissReviewComment).toHaveBeenCalledWith("session-1", "comment-1");
  });

  it("reports a store failure as a 400 rather than throwing", async () => {
    dismissReviewComment.mockRejectedValue(new Error("db down"));

    const res = await PATCH(new Request("http://x/", { method: "PATCH" }), {
      params: Promise.resolve({ commentId: "comment-1", id: "session-1" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.message).toContain("db down");
  });
});
