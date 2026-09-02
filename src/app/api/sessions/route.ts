import { NextResponse } from "next/server";

import { handleRouteError, requireUser } from "@/lib/api-helpers";
import { parseRequestedSessionId } from "@/lib/pi/session-id";
import { writeSessionMeta } from "@/lib/pi/session-meta";
import { mirrorSessionProjects } from "@/lib/pi/session-project-mirror";
import { attachProject } from "@/lib/pi/session-project-links";

/**
 * Create a session.
 *
 * This is on the critical path of a click: /sessions/new waits for the id
 * before it can navigate anywhere, so every round trip here is time the user
 * spends looking at the page they just left. It should make exactly one.
 */
export async function POST(request: Request) {
  try {
    // Through the helper, not a bare auth.getUser(): bound to loopback there is
    // nobody to authenticate, and this route was the only one still asking
    // Supabase Auth who the user is — a round trip the policy in auth-mode.ts
    // exists to avoid.
    const { supabase, user } = await requireUser();

    const body = await request.json().catch(() => ({}));
    const title = typeof body?.title === "string" && body.title.trim()
      ? body.title.trim()
      : "New Session";
    // Workspace-relative, which for a first-level project is just its name. The
    // absolute path this used to take was only ever turned back into a relative
    // one, and it meant the wire carried a path that means nothing off this host.
    const project = typeof body?.project === "string" && body.project.trim()
      ? body.project.trim()
      : null;

    // The client may mint the id so /sessions/new can navigate before this
    // request is sent; see session-id.ts for why it is validated. An id already
    // in use fails the insert, which is the right answer for a collision.
    const requestedId = parseRequestedSessionId(body?.id);

    const { data, error } = await supabase
      .from("sessions")
      .insert(
        requestedId
          ? { id: requestedId, title, user_id: user.id }
          : { title, user_id: user.id },
      )
      .select("id")
      .single();

    if (error) {
      console.error("[api:sessions] Failed to create session:", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // One timestamp for the record and the link it carries, so the session and
    // its first project do not disagree about when they began.
    const createdAt = new Date().toISOString();

    // A project chosen from a card is an explicit link, and the anchor.
    const projects = project
      ? attachProject([], {
          at: createdAt,
          origin: "explicit",
          path: project,
          primary: true,
        })
      : [];

    // Recorded on disk too, so the session is findable without the database.
    // This is also what the session page reads first, so it is the write that
    // has to happen before the response.
    writeSessionMeta(data.id, {
      title,
      projects,
      userId: user.id,
      createdAt,
    });

    // Not awaited, and skipped entirely when there is nothing to mirror.
    //
    // It replaces a session's links by deleting them first, which for a session
    // created one line ago can only delete nothing — a whole round trip to
    // establish that. And it is best-effort by contract: the disk write above
    // has already succeeded, so waiting for the copy only delays the id the
    // caller is blocked on.
    if (projects.length > 0) {
      void mirrorSessionProjects(data.id, projects);
    }

    return NextResponse.json({ id: data.id }, { status: 201 });
  } catch (error) {
    return handleRouteError(error, "Could not create a new session.");
  }
}
