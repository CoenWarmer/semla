import { handleRouteError, requireUser } from "@/lib/api-helpers";

export const runtime = "nodejs";

export async function GET() {
  try {
    const { supabase, user } = await requireUser();
    const { data, error } = await supabase
      .from("user_settings")
      .select("default_model_id, default_model_provider, system_prompt")
      .eq("user_id", user.id)
      .maybeSingle();

    if (error) {
      throw error;
    }

    return Response.json({ settings: data });
  } catch (error) {
    return handleRouteError(error, "Unable to load user settings.");
  }
}

export async function PUT(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    defaultModelId?: unknown;
    defaultModelProvider?: unknown;
    systemPrompt?: unknown;
  } | null;

  const hasModel =
    body?.defaultModelId !== undefined || body?.defaultModelProvider !== undefined;
  const hasSystemPrompt = body?.systemPrompt !== undefined;

  if (!hasModel && !hasSystemPrompt) {
    return Response.json({ error: "Nothing to update." }, { status: 400 });
  }

  const defaultModelId =
    typeof body?.defaultModelId === "string" ? body.defaultModelId : null;
  const defaultModelProvider =
    typeof body?.defaultModelProvider === "string" ? body.defaultModelProvider : null;

  if (hasModel && (!defaultModelId || !defaultModelProvider)) {
    return Response.json({ error: "Both model ID and provider are required." }, { status: 400 });
  }

  const systemPrompt =
    typeof body?.systemPrompt === "string"
      ? body.systemPrompt
      : body?.systemPrompt === null
        ? null
        : undefined;

  try {
    const { supabase, user } = await requireUser();

    const { data, error } = await supabase
      .from("user_settings")
      .upsert(
        {
          updated_at: new Date().toISOString(),
          user_id: user.id,
          ...(hasModel
            ? { default_model_id: defaultModelId, default_model_provider: defaultModelProvider }
            : {}),
          ...(hasSystemPrompt ? { system_prompt: systemPrompt ?? null } : {}),
        },
        { onConflict: "user_id" }
      )
      .select("default_model_id, default_model_provider, system_prompt")
      .single();

    if (error) {
      throw error;
    }

    return Response.json({ settings: data });
  } catch (error) {
    return handleRouteError(error, "Unable to save settings.");
  }
}
