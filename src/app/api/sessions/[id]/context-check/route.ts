import { handleRouteError } from "@/lib/api/api-helpers";
import { runContextCheck } from "@/lib/context-check/run-context-check";
import type { ContextCheckResult, StoredInspection } from "@/lib/context-check/types";
import { requireSessionOwner } from "@/lib/auth/session-auth";
import { getTranscript } from "@/lib/pi/transcript";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

// ---- Route handler ------------------------------------------------------

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    await requireSessionOwner(id);
    const supabase = await createClient();
    const { messages, toolCalls } = await getTranscript(supabase, id);

    if (messages.length === 0) {
      const result = await runContextCheck({
        goal: null,
        messages,
        semlaSessionId: id,
        systemPromptChars: 0,
        toolCalls,
      });
      return Response.json(result satisfies ContextCheckResult);
    }

    // Fetch goal and system prompt in parallel
    const [{ data: sessionRow }, { data: userSettings }] = await Promise.all([
      supabase.from("sessions").select("goal").eq("id", id).maybeSingle(),
      supabase.from("user_settings").select("system_prompt").maybeSingle(),
    ]);
    const goal = sessionRow?.goal ?? null;
    const systemPromptChars =
      typeof userSettings?.system_prompt === "string"
        ? userSettings.system_prompt.length
        : 0;

    const result = await runContextCheck({
      goal,
      messages,
      semlaSessionId: id,
      systemPromptChars,
      toolCalls,
    });

    // Persist — non-fatal if it fails
    await supabase
      .from("context_inspections")
      .insert({ result: result as unknown as import("@/types/database.types").Json, semla_session_id: id })
      .then(({ error }) => {
        if (error) console.error("[context-check] Failed to persist inspection:", error.message);
      });

    return Response.json(result);
  } catch (error) {
    return handleRouteError(error, "Unable to run context check.");
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    // Polled before a session created by its own first prompt exists. This
    // handler reads stored inspections and answers with an empty list for a
    // session that has none, which is the right answer rather than a refusal.
    // The POST above must keep refusing: it writes a row against the session.
    await requireSessionOwner(id, undefined, { allowMissing: true });
    const supabase = await createClient();

    const { data, error } = await supabase
      .from("context_inspections")
      .select("id, created_at, result")
      .eq("semla_session_id", id)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) return handleRouteError(error, "Unable to load inspections.");

    const inspections: StoredInspection[] = (data ?? []).map((row) => ({
      createdAt: row.created_at,
      id: row.id,
      result: row.result as unknown as ContextCheckResult,
    }));

    return Response.json({ inspections });
  } catch (error) {
    return handleRouteError(error, "Unable to load inspections.");
  }
}
