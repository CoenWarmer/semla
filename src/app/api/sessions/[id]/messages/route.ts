import { handleRouteError } from "@/lib/api-helpers";
import { requireSessionOwner } from "@/lib/session-auth";
import { resolveSessionPromptContext } from "@/lib/pi/session-prompt-context";
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
    const { user } = await requireSessionOwner(id);
    const supabase = await createClient();

    // The system prompt's size travels with the transcript because the two are
    // always wanted together: the context-window bar is arithmetic over both,
    // and fetching them separately meant a second route re-reading this same
    // transcript to answer a question the browser could already answer.
    const [{ messages, toolCalls }, { systemPrompt }] = await Promise.all([
      getTranscript(supabase, id),
      resolveSessionPromptContext(supabase, id, user.id),
    ]);

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

    return Response.json({
      contextWindow,
      messages,
      systemPromptChars: systemPrompt.length,
      toolCalls,
    });
  } catch (error) {
    return handleRouteError(error, "Unable to load session.");
  }
}
