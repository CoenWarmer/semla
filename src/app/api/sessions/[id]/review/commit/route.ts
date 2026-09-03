import { NextResponse } from "next/server";

import { commitStaged } from "@/lib/pi/review-apply";
import { resolveReviewTarget } from "@/lib/pi/review-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Commit what the operator staged, as the operator.
 *
 * This is the act the whole panel exists to make possible, and the reason it
 * is a route of its own rather than an action parameter on the review read:
 * everything else here is reversible, and this is the one that writes history.
 *
 * The commit uses the repository's own configured identity and adds no
 * trailer. It should be indistinguishable from one made by hand in a terminal,
 * because that is what it is — the agent proposed, a person approved.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json().catch(() => null);
  const message = typeof body?.message === "string" ? body.message : "";

  const target = await resolveReviewTarget(id, body?.project ?? null);
  if (!target) {
    return NextResponse.json(
      { message: "Not a project this session is linked to.", ok: false },
      { status: 400 },
    );
  }

  return NextResponse.json(await commitStaged(target.root, message));
}
