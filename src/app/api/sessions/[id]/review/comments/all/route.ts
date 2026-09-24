import { NextResponse } from "next/server";

import { listAllReviewComments } from "@/lib/pi/review/review-comment-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Every live comment of this session, across every file and project, oldest
 * first — the sequence the comment cards' navigation arrows step through.
 *
 * Its own route rather than a `?all=1` flag on the sibling GET, because the
 * two have different cache keys on the client: one is keyed by file and
 * refetched when a file opens, this one is keyed by session and is the
 * ordering the arrows read. Folding them together would mean one query key
 * serving two different answers depending on a query parameter, which is the
 * mistake `reviewHunksQueryKey`'s own doc calls out for `sha`.
 *
 * Unlike the per-file GET there is no `withReviewTarget` guard, and there is
 * nothing for one to check: no project or path is accepted from the caller at
 * all. The session id in the URL is the only filter, comments are stored
 * already scoped to the session that created them, and this never touches the
 * filesystem or git. A project the session is no longer linked to simply
 * cannot appear, because nothing ever wrote a comment against one.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const comments = await listAllReviewComments(id);
  return NextResponse.json({ comments });
}
