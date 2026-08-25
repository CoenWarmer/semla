import { handleRouteError } from "@/lib/api-helpers";
import { requireSessionOwner } from "@/lib/session-auth";
import { createClient } from "@/lib/supabase/server";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    await requireSessionOwner(id);
  } catch (error) {
    return handleRouteError(error, "Unable to authorize session.");
  }

  const body = (await request.json().catch(() => null)) as {
    title?: unknown;
  } | null;

  const title =
    typeof body?.title === "string" && body.title.trim()
      ? body.title.trim()
      : null;

  if (!title) {
    return Response.json({ error: "title is required." }, { status: 400 });
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("sessions")
    .update({ title })
    .eq("id", id);

  if (error) {
    console.error(`[api:sessions/${id}] Failed to rename session:`, error);
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ ok: true });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    await requireSessionOwner(id);
  } catch (error) {
    return handleRouteError(error, "Unable to authorize session.");
  }

  const supabase = await createClient();
  const { error } = await supabase.from("sessions").delete().eq("id", id);

  if (error) {
    console.error(`[api:sessions/${id}] Failed to delete session:`, error);
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ ok: true });
}
