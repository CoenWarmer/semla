/**
 * Everything a client needs to render a session's transcript, built once.
 *
 * The route and the page that server-renders it must agree, because the page's
 * result is seeded straight into the query cache as `initialData` — and with a
 * staleTime, a query that starts with initial data does not refetch. Anything
 * the page leaves out is therefore not merely late, it is absent until
 * something else invalidates.
 *
 * That is not hypothetical: the page used to hand over `{ contextWindow: null,
 * ...transcript }`, which was harmless while the context-window bar fetched its
 * own numbers, and became a bar drawn at 100% the moment the bar started
 * reading them from here.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { modelContextWindow } from "@/lib/pi/context-composition";
import { resolveSessionPromptContext } from "@/lib/pi/session-prompt-context";
import { getTranscript, type SessionToolCall, type SessionTranscriptEntry } from "@/lib/pi/transcript";
import { createAdminClient } from "@/lib/supabase-admin";

export type SessionMessagesPayload = {
  contextWindow: number | null;
  messages: SessionTranscriptEntry[];
  /** Size of the system prompt a turn would actually be sent with. */
  systemPromptChars: number;
  toolCalls: SessionToolCall[];
};

export async function buildSessionMessages(
  supabase: SupabaseClient,
  sessionId: string,
  userId: string,
): Promise<SessionMessagesPayload> {
  // The same string a turn would actually be sent with, not just whatever
  // override the user has saved — most sessions have none.
  const [{ messages, toolCalls }, { defaultModel, systemPrompt }] =
    await Promise.all([
      getTranscript(supabase, sessionId),
      resolveSessionPromptContext(supabase, sessionId, userId),
    ]);

  // A pi_sessions row is written by the first turn, so a session nobody has
  // prompted yet has no model recorded against it. Fall back to the model it
  // would use — otherwise the window size is unknown for exactly the new
  // session the bar was asked to draw.
  let contextWindow: number | null = null;
  try {
    const admin = createAdminClient();
    const { data: piSession } = await admin
      .from("pi_sessions")
      .select("model_id, model_provider")
      .eq("semla_session_id", sessionId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    contextWindow = await modelContextWindow(
      piSession?.model_provider ?? defaultModel?.provider,
      piSession?.model_id ?? defaultModel?.modelId,
    );
  } catch {
    // Non-fatal — the bar shows proportions and says the window is unknown.
  }

  return {
    contextWindow,
    messages,
    systemPromptChars: systemPrompt.length,
    toolCalls,
  };
}
