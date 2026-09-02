import { NextResponse } from "next/server";

import { handleRouteError, requireUser } from "@/lib/api-helpers";
import {
  createSession,
  readSessionCreateRequest,
} from "@/lib/pi/session-create";

/**
 * Create a session explicitly.
 *
 * /sessions/new no longer comes through here: it mints the id itself, navigates
 * immediately, and lets the prompt request create the session it is prompting —
 * one request rather than two, with nothing between the navigation and the
 * agent starting. This remains for callers that want a session with no prompt
 * to put in it yet, like the wiki browser opening one.
 *
 * The work itself is in session-create.ts, shared with that prompt route so the
 * two cannot disagree about what a new session is.
 */
export async function POST(request: Request) {
  try {
    // Through the helper, not a bare auth.getUser(): bound to loopback there is
    // nobody to authenticate, and this route was the only one still asking
    // Supabase Auth who the user is — a round trip the policy in auth-mode.ts
    // exists to avoid.
    const { supabase, user } = await requireUser();

    const body = await request.json().catch(() => ({}));
    const { id, project, title } = readSessionCreateRequest(body);

    const result = await createSession({
      client: supabase,
      id,
      project,
      title,
      userId: user.id,
    });

    if (result.kind === "failed") {
      return NextResponse.json({ error: result.message }, { status: 500 });
    }

    if (result.kind === "exists") {
      return NextResponse.json(
        { error: "That session already exists." },
        { status: 409 },
      );
    }

    return NextResponse.json({ id: result.id }, { status: 201 });
  } catch (error) {
    return handleRouteError(error, "Could not create a new session.");
  }
}
