import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

import { writeSessionMeta } from "@/lib/pi/session-meta";

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

  // Recorded on disk too, so the session is findable without the database.
  writeSessionMeta(data.id, {
    title,
    projectPath,
    userId: user.id,
    createdAt: new Date().toISOString(),
  });

  return NextResponse.json({ id: data.id }, { status: 201 });
}
