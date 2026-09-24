import { NextResponse } from "next/server";

import {
  errorFailure,
  messageFailure,
  withReviewTarget,
} from "@/lib/pi/review/review-service";
import {
  createReviewComment,
  listReviewComments,
} from "@/lib/pi/review/review-comment-store";
import { isReviewCommentBody } from "@/lib/review/review-comment-types";
import { sessionAccessDenied } from "@/lib/auth/session-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Live comments for one file — what the editor pane asks for when a file is
 * opened, so a comment from an earlier turn still shows up on reopening the
 * panel and not only for ones created in the live SSE stream this session.
 *
 * The repository is resolved from the session's own project links, same
 * guard every review route runs — see `withReviewTarget`'s docblock. `path`
 * is not additionally contained with `resolveInsideRoot` the way a file-read
 * route would: this never touches the filesystem, it is a database filter,
 * and an unresolvable path just returns no rows.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const denied = await sessionAccessDenied(id, { allowMissing: true });
  if (denied) return denied;
  const url = new URL(request.url);
  const project = url.searchParams.get("project");
  const path = url.searchParams.get("path");

  if (!path) {
    return NextResponse.json({ error: "path required" }, { status: 400 });
  }

  return withReviewTarget(
    {
      onFailure: errorFailure({ project: "Not a project this session is linked to." }),
      project,
      sessionId: id,
    },
    async (target) => {
      const comments = await listReviewComments(id, target.link.path, path);
      return NextResponse.json({ comments });
    },
  );
}

/**
 * Manually attach a comment to a range, outside the `open_review` tool call
 * path.
 *
 * Not currently reachable from the UI — the only writer in this phase is
 * `open_review`'s own `execute` (open-review.ts), which calls
 * `createReviewComment` directly rather than round-tripping through HTTP.
 * This exists for symmetry with every other review route (a POST beside its
 * GET) and so a future operator-authored comment has somewhere to land
 * without a second route being invented for it.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const denied = await sessionAccessDenied(id);
  if (denied) return denied;
  const body = await request.json().catch(() => null);

  const path = typeof body?.path === "string" ? body.path : null;
  const startLine = Number.isInteger(body?.startLine) ? (body.startLine as number) : null;
  const endLine = Number.isInteger(body?.endLine) ? (body.endLine as number) : null;
  const commentBody = isReviewCommentBody(body?.body) ? body.body : null;

  if (!path || startLine === null || endLine === null || !commentBody) {
    return NextResponse.json(
      { message: "path, startLine, endLine and a valid body are required.", ok: false },
      { status: 400 },
    );
  }
  if (endLine < startLine) {
    return NextResponse.json(
      { message: "endLine must not be less than startLine.", ok: false },
      { status: 400 },
    );
  }

  return withReviewTarget(
    {
      onFailure: messageFailure({ project: "Not a project this session is linked to." }),
      project: body?.project ?? null,
      sessionId: id,
    },
    async (target) => {
      const comment = await createReviewComment({
        body: commentBody,
        endLine,
        filePath: path,
        projectPath: target.link.path,
        sessionId: id,
        startLine,
        toolCallId: null,
      });
      return NextResponse.json({ comment, ok: true });
    },
  );
}
