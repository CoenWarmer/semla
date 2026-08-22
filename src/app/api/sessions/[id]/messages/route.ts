import { createClient } from "@/app/utils/supabase/server";
import { requireSessionOwner } from "@/lib/session-auth";
import { getTranscript } from "@/lib/pi/transcript";

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
    if (error instanceof Response) {
      return error;
    }

    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Unable to load session.",
      },
      { status: 500 }
    );
  }
}
