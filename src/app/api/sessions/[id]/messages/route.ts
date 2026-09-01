import { handleRouteError } from "@/lib/api-helpers";
import { buildSessionMessages } from "@/lib/pi/session-messages-payload";
import { requireSessionOwner } from "@/lib/session-auth";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const { user } = await requireSessionOwner(id);
    const supabase = await createClient();

    return Response.json(await buildSessionMessages(supabase, id, user.id));
  } catch (error) {
    return handleRouteError(error, "Unable to load session.");
  }
}
