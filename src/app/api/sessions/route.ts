import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

import { PI_WORKSPACE_ROOT } from "@/lib/pi/runtime-config";
import { writeSessionMeta } from "@/lib/pi/session-meta";
import { mirrorSessionProjects } from "@/lib/pi/session-project-mirror";
import { attachProject } from "@/lib/pi/session-project-links";
import { projectPrefix } from "@/lib/pi/session-project";

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
  const projectPath = typeof body?.projectPath === "string" && body.projectPath.trim()
    ? body.projectPath.trim()
    : null;

  const { data, error } = await userClient
    .from("sessions")
    .insert({ title, project_path: projectPath, user_id: user.id })
    .select("id")
    .single();

  if (error) {
    console.error("[api:sessions] Failed to create session:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // One timestamp for the record and the link it carries, so the session and
  // its first project do not disagree about when they began.
  const createdAt = new Date().toISOString();

  // A project chosen from a card is an explicit link, and the anchor. Stored
  // workspace-relative: an absolute path recorded on the host means nothing in
  // the container. A project outside the workspace root has no relative form
  // and is simply not linked — projectPath still records where it was.
  const relativePath = projectPrefix(PI_WORKSPACE_ROOT, projectPath);
  const projects = relativePath
    ? attachProject([], {
        at: createdAt,
        origin: "explicit",
        path: relativePath,
        primary: true,
      })
    : [];

  // Recorded on disk too, so the session is findable without the database.
  writeSessionMeta(data.id, {
    title,
    projectPath,
    projects,
    userId: user.id,
    createdAt,
  });

  // Best-effort, and after the disk write that actually matters.
  await mirrorSessionProjects(data.id, projects);

  return NextResponse.json({ id: data.id }, { status: 201 });
}
