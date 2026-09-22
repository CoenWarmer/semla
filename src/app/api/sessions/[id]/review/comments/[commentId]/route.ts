import { NextResponse } from "next/server";

import { dismissReviewComment } from "@/lib/pi/review/review-comment-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Dismiss one comment.
 *
 * No project/path resolution here — unlike every other review route, this
 * one does not need to know which repository the comment is about, because
 * it does not touch the filesystem or git at all. `dismissReviewComment`
 * scopes the update by `sessionId` (from the path) and `id` (from the path),
 * which is the whole containment this action needs: a comment belongs to
 * exactly one session, and the id is a random uuid the caller cannot
 * meaningfully guess across sessions even without that scoping.
 */
export async function PATCH(
  _request: Request,
  { params }: { params: Promise<{ id: string; commentId: string }> },
) {
  const { id, commentId } = await params;

  try {
    await dismissReviewComment(id, commentId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      {
        message: error instanceof Error ? error.message : "Unable to dismiss the comment.",
        ok: false,
      },
      { status: 400 },
    );
  }
}
