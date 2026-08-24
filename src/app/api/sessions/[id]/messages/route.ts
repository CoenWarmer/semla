import { handleRouteError } from "@/lib/api-helpers";
import { requireSessionOwner } from "@/lib/session-auth";
import { getTranscript } from "@/lib/pi/transcript";
import { createAdminClient } from "@/lib/supabase-admin";
import { createClient } from "@/lib/supabase/server";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    await requireSessionOwner(id);
    const supabase = await createClient();
    const messages = await getTranscript(supabase, id);

    // Look up the model context window for the most recent pi session
    let contextWindow: number | null = null;
    try {
      const admin = createAdminClient();
      const { data: piSession } = await admin
        .from("pi_sessions")
        .select("model_id, model_provider")
        .eq("semla_session_id", id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (piSession?.model_id && piSession?.model_provider) {
        const runtime = await ModelRuntime.create({ refreshOnCreate: false });
        const model = runtime.getModel(piSession.model_provider, piSession.model_id);
        contextWindow = model?.contextWindow ?? null;
      }
    } catch {
      // Non-fatal — contextWindow stays null
    }

    return Response.json({ contextWindow, messages });
  } catch (error) {
    return handleRouteError(error, "Unable to load session.");
  }
}
