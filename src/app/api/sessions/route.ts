import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

import { writeSessionMeta } from "@/lib/pi/session-meta";
import { mirrorSessionProjects } from "@/lib/pi/session-project-mirror";
import { attachProject } from "@/lib/pi/session-project-links";

export async function POST(request: Request) {
  const userClient = await createClient();
  const {
    data: { user },
  } = await userClient.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

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

  const { data, error } = await userClient
    .from("sessions")
    .insert({ title, user_id: user.id })
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
  writeSessionMeta(data.id, {
    title,
    projects,
    userId: user.id,
    createdAt,
  });

  // Best-effort, and after the disk write that actually matters.
  await mirrorSessionProjects(data.id, projects);

  return NextResponse.json({ id: data.id }, { status: 201 });
}
