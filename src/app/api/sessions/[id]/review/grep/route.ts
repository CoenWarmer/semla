import { NextResponse } from "next/server";

import { grepProject } from "@/lib/pi/review-grep";
import { resolveReviewTarget } from "@/lib/pi/review-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Lines in the project containing the filter query.
 *
 * Separate from `/files/search`, which matches paths. The two answer different
 * questions and finish at different times — a name match is a walk of the file
 * list, a content match is a sweep of the file contents — and folding them
 * into one response would hold the fast, usually-sufficient answer behind the
 * slow one. Split, the names render immediately and the contents fill in
 * underneath, which is the same reason `/files/search` splits project from
 * workspace.
 *
 * The repository is resolved from the session's own project links; the query
 * is the only thing here that comes from the caller, and `grepProject` passes
 * it after `-e` so it cannot be read as an option.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(request.url);
  const query = url.searchParams.get("q") ?? "";

  const target = await resolveReviewTarget(id, url.searchParams.get("project"));
  if (!target) {
    return NextResponse.json(
      { error: "Not a project this session is linked to." },
      { status: 400 },
    );
  }

  return NextResponse.json(await grepProject(target.root, query));
}
