import { NextResponse } from "next/server";

import { readSessionReview } from "@/lib/pi/review/review-service";
import { markReviewed } from "@/lib/pi/review/review-turn-mark";
import { sessionAccessDenied } from "@/lib/auth/session-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What there is to review in this session's projects, anchor first.
 *
 * Read from `git status` rather than from the agent's tool calls. Semla
 * already observes `edit` and `write` to attach projects to a session, but
 * that observation cannot see writes made through `bash` — `sed -i`, `mv`,
 * generated output — and a review panel built on it would open empty after a
 * turn that changed a dozen files. See src/lib/pi/review/review-status.ts.
 *
 * Keyed the way `/api/sessions/[id]/git` keys: by workspace-relative project
 * path, anchor first, so a caller with no particular project in mind gets the
 * anchor by taking the first entry.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const denied = await sessionAccessDenied(id, { allowMissing: true });
  if (denied) return denied;
  return NextResponse.json(await readSessionReview(id));
}

/**
 * Record that the operator has seen a state, so the panel stops offering it.
 *
 * The fingerprint is supplied by the caller rather than recomputed here on
 * purpose: dismissing means "I have seen *what I was shown*", and re-reading
 * git would record a verdict on a state that may already have moved.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const denied = await sessionAccessDenied(id);
  if (denied) return denied;
  const body = await request.json().catch(() => null);
  const seen = body?.fingerprint;

  if (typeof seen !== "string" || seen === "") {
    return NextResponse.json(
      { message: "A fingerprint is required.", ok: false },
      { status: 400 },
    );
  }

  markReviewed(id, seen);
  return NextResponse.json({ ok: true });
}
