import { NextResponse } from "next/server";

import { resolveReviewTarget } from "@/lib/pi/review-service";
import { performReset, planReset } from "@/lib/pi/review-reset";
import { readTurnMark } from "@/lib/pi/review-turn-mark";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Bring the agent's commits from this turn back into the working tree.
 *
 * Two methods for one operation, deliberately. GET is the plan: what would
 * come back, and every reason it might not be allowed, so the panel can show
 * the refusal beside a disabled button rather than only after the operator
 * commits to the action. POST does it, and only when handed back the target
 * GET reported — a panel left open across another turn is describing a range
 * that no longer exists.
 *
 * The start sha comes from Semla's own turn mark, never from the request. It
 * is the one thing that makes "this turn" mean anything, and a caller-supplied
 * sha would turn a review action into an arbitrary `git reset`.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const project = new URL(request.url).searchParams.get("project");

  const target = await resolveReviewTarget(id, project);
  if (!target) {
    return NextResponse.json(
      { error: "Not a project this session is linked to." },
      { status: 400 },
    );
  }

  const mark = readTurnMark(id);
  const startSha = mark?.projects[target.link.path]?.head ?? null;

  return NextResponse.json(await planReset(target.root, startSha));
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json().catch(() => null);
  const expected = typeof body?.target === "string" ? body.target : null;

  if (!expected) {
    return NextResponse.json(
      { message: "The target commit is required.", ok: false },
      { status: 400 },
    );
  }

  const target = await resolveReviewTarget(id, body?.project ?? null);
  if (!target) {
    return NextResponse.json(
      { message: "Not a project this session is linked to.", ok: false },
      { status: 400 },
    );
  }

  const mark = readTurnMark(id);
  const startSha = mark?.projects[target.link.path]?.head ?? null;

  return NextResponse.json(
    await performReset(target.root, startSha, expected),
  );
}
