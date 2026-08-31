import { handleRouteError, requireUser } from "@/lib/api-helpers";
import {
  readUserSettings,
  writeUserSettings,
  type UserSettings,
} from "@/lib/user-settings-store";

/** The column names the settings UI already expects. */
const toRow = (settings: UserSettings) => ({
  default_model_id: settings.defaultModelId,
  default_model_provider: settings.defaultModelProvider,
  system_prompt: settings.systemPrompt,
});

export const runtime = "nodejs";

export async function GET() {
  try {
    const { supabase, user } = await requireUser();

    // Disk answers when it has a record; Postgres still serves settings saved
    // before the record existed, and seeds one so the next read is local.
    const onDisk = readUserSettings(user.id);
    if (onDisk) {
      return Response.json({ settings: toRow(onDisk) });
    }

    const { data, error } = await supabase
      .from("user_settings")
      .select("default_model_id, default_model_provider, system_prompt")
      .eq("user_id", user.id)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (data) {
      writeUserSettings(user.id, {
        defaultModelId: data.default_model_id,
        defaultModelProvider: data.default_model_provider,
        systemPrompt: data.system_prompt,
      });
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

    // Written to disk first: this is the copy that has to survive.
    const saved = writeUserSettings(user.id, {
      ...(hasModel
        ? { defaultModelId: defaultModelId as string, defaultModelProvider: defaultModelProvider as string }
        : {}),
      ...(hasSystemPrompt ? { systemPrompt: systemPrompt ?? null } : {}),
    });

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

    // The save already succeeded on disk, which is the copy that decides how
    // sessions behave. A database that cannot take the mirror is worth
    // reporting, not worth telling the user their settings were lost.
    if (error) {
      console.warn(`[api:user-settings] mirror to Postgres failed: ${error.message}`);
      return Response.json({ settings: toRow(saved) });
    }

    return Response.json({ settings: data });
  } catch (error) {
    return handleRouteError(error, "Unable to save settings.");
  }
}
