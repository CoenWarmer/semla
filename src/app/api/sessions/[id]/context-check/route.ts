import { handleRouteError } from "@/lib/api-helpers";
import { requireSessionOwner } from "@/lib/session-auth";
import { getTranscript } from "@/lib/pi/transcript";
import { createAdminClient } from "@/lib/supabase-admin";
import { createClient } from "@/lib/supabase/server";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export const runtime = "nodejs";

export type ContextCheckResult = {
  quality: "good" | "warning" | "degraded";
  summary: string;
};

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    await requireSessionOwner(id);
    const supabase = await createClient();
    const allMessages = await getTranscript(supabase, id);

    // Only last 20 messages to keep prompt small
    const recent = allMessages.slice(-20);
    if (recent.length === 0) {
      return Response.json({ quality: "good", summary: "No messages to assess." } satisfies ContextCheckResult);
    }

    // Look up the model for this session
    const admin = createAdminClient();
    const { data: piSession } = await admin
      .from("pi_sessions")
      .select("model_id, model_provider")
      .eq("semla_session_id", id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!piSession?.model_id || !piSession?.model_provider) {
      return Response.json({ quality: "good", summary: "Unable to determine model." } satisfies ContextCheckResult);
    }

    const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
    const apiKey = process.env.PI_MODEL_API_KEY;
    if (apiKey) {
      await modelRuntime.setRuntimeApiKey(piSession.model_provider, apiKey);
    }
    const model = modelRuntime.getModel(piSession.model_provider, piSession.model_id);
    if (!model) {
      return Response.json({ quality: "good", summary: "Model unavailable." } satisfies ContextCheckResult);
    }

    // Build a minimal context for the quality check
    const contextMessages = recent.map((m) => ({
      role: m.role as "user" | "assistant",
      content: [{ type: "text" as const, text: m.text }],
    }));

    const result = await modelRuntime.completeSimple(model, {
      messages: contextMessages as Parameters<typeof modelRuntime.completeSimple>[1]["messages"],
      systemPrompt:
        "You are reviewing an AI coding assistant session. Assess whether the assistant's responses show signs of context rot: repetition, inconsistency, forgetting earlier instructions, or declining answer quality. Respond with ONLY a JSON object: {\"quality\": \"good\" | \"warning\" | \"degraded\", \"summary\": \"one sentence\"}",
    });

    const text = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("");

    // Extract JSON — the model may wrap it in ```json fences
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return Response.json({ quality: "good", summary: "Unable to parse assessment." } satisfies ContextCheckResult);
    }

    const parsed = JSON.parse(jsonMatch[0]) as Partial<ContextCheckResult>;
    const quality = (["good", "warning", "degraded"] as const).includes(parsed.quality as "good" | "warning" | "degraded")
      ? (parsed.quality as ContextCheckResult["quality"])
      : "good";

    return Response.json({
      quality,
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
    } satisfies ContextCheckResult);
  } catch (error) {
    return handleRouteError(error, "Unable to run context check.");
  }
}
