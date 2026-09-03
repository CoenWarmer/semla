import { NextResponse } from "next/server";

import { readSessionReview } from "@/lib/pi/review-service";
import { markReviewed } from "@/lib/pi/review-turn-mark";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What there is to review in this session's projects, anchor first.
 *
 * Read from `git status` rather than from the agent's tool calls. Semla
 * already observes `edit` and `write` to attach projects to a session, but
 * that observation cannot see writes made through `bash` — `sed -i`, `mv`,
 * generated output — and a review panel built on it would open empty after a
 * turn that changed a dozen files. See src/lib/pi/review-status.ts.
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
