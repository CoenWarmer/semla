import { handleRouteError } from "@/lib/api-helpers";
import {
  EMPTY_COMPOSITION,
  computeComposition,
  contextWindowUsage,
  latestInputTokens,
  modelContextWindow,
  type CompositionBreakdown,
} from "@/lib/pi/context-composition";
import { resolveSessionPromptContext } from "@/lib/pi/session-prompt-context";
import { getTranscript } from "@/lib/pi/transcript";
import { requireSessionOwner } from "@/lib/session-auth";
import { createAdminClient } from "@/lib/supabase-admin";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What the session's context window is made of, right now.
 *
 * Split out from the context *check* so the bar in the top bar can be drawn
 * from the first render of a session. The check asks a model to judge drift
 * and staleness, costs a call, and so only ran when somebody opened the
 * inspector — which meant the composition bar, which needs none of that, was
 * invisible until they did.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const { user } = await requireSessionOwner(id);
    const supabase = await createClient();

    // The same string a turn would actually be sent with, not just whatever
    // override the user has saved — most sessions have none.
    const [{ messages, toolCalls }, { systemPrompt }] = await Promise.all([
      getTranscript(supabase, id),
      resolveSessionPromptContext(supabase, id, user.id),
    ]);

    const systemPromptChars = systemPrompt.length;

    // A session with nothing in it yet still has a system prompt, and that is
    // worth drawing: it is the floor every conversation starts from.
    if (messages.length === 0 && systemPromptChars === 0) {
      return Response.json(EMPTY_COMPOSITION satisfies CompositionBreakdown);
    }

    const metrics = computeComposition(messages, toolCalls, systemPromptChars);

    const admin = createAdminClient();
    const { data: piSession } = await admin
      .from("pi_sessions")
      .select("model_id, model_provider")
      .eq("semla_session_id", id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const contextWindow = await modelContextWindow(
      piSession?.model_provider,
      piSession?.model_id,
    );

    return Response.json({
      assistantFraction: metrics.assistantFraction,
      summary: metrics.summary,
      systemPromptFraction: metrics.systemPromptFraction,
      toolResultFraction: metrics.toolResultFraction,
      userFraction: metrics.userFraction,
      ...contextWindowUsage(
        latestInputTokens(messages),
        metrics.totalChars,
        contextWindow,
      ),
    } satisfies CompositionBreakdown);
  } catch (error) {
    return handleRouteError(error, `[sessions/${id}/composition]`);
  }
}
