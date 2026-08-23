import { handleRouteError } from "@/lib/api-helpers";
import { requireSessionOwner } from "@/lib/session-auth";
import { getTranscript } from "@/lib/pi/transcript";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    await requireSessionOwner(id);
    const supabase = await createClient();
    return Response.json({ messages: await getTranscript(supabase, id) });
  } catch (error) {
    return handleRouteError(error, "Unable to load session.");
  }
}
