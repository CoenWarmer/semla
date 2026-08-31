import { handleRouteError } from "@/lib/api-helpers";
import { writeSessionMeta } from "@/lib/pi/session-meta";
import { requireSessionOwner } from "@/lib/session-auth";
import { createClient } from "@/lib/supabase/server";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();

  try {
    await requireSessionOwner(id, supabase);
  } catch (error) {
    return handleRouteError(error, "Unable to authorize session.");
  }

  const body = (await request.json().catch(() => null)) as {
    title?: unknown;
    goal?: unknown;
  } | null;

  const title =
    typeof body?.title === "string" && body.title.trim()
      ? body.title.trim()
      : undefined;

  const goal =
    typeof body?.goal === "string"
      ? body.goal.trim() || null
      : undefined;

  if (title === undefined && goal === undefined) {
    return Response.json({ error: "title or goal is required." }, { status: 400 });
  }

  const patch: { title?: string; goal?: string | null } = {};
  if (title !== undefined) patch.title = title;
  if (goal !== undefined) patch.goal = goal;

  writeSessionMeta(id, {
    ...(title !== undefined ? { title } : {}),
    ...(goal !== undefined ? { goal } : {}),
  });

  const { error } = await supabase
    .from("sessions")
    .update(patch)
    .eq("id", id);

  if (error) {
    console.error(`[api:sessions/${id}] Failed to update session:`, error);
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ ok: true });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();

  try {
    await requireSessionOwner(id, supabase);
  } catch (error) {
    return handleRouteError(error, "Unable to authorize session.");
  }

  const { error } = await supabase.from("sessions").delete().eq("id", id);

  if (error) {
    console.error(`[api:sessions/${id}] Failed to delete session:`, error);
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ ok: true });
}
