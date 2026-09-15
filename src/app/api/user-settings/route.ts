import { handleRouteError, requireUser } from "@/lib/api/api-helpers";
import {
  readUserSettings,
  writeUserSettings,
  type UserSettings,
} from "@/lib/stores/user-settings-store";

/**
 * The column names the settings UI already expects.
 *
 * `follow_mode` is not one of them — it has no Postgres column, so it rides
 * along only on the disk-backed answer. A client reading the database fallback
 * sees it absent, which `followModeEnabled` reads as the default.
 */
const toRow = (settings: UserSettings) => ({
  default_model_id: settings.defaultModelId,
  default_model_provider: settings.defaultModelProvider,
  follow_mode: settings.followMode,
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

    if (!data) return Response.json({ settings: null });

    // Answered from the record just seeded rather than from `data`, so the
    // response carries `follow_mode` — a column the select cannot name.
    return Response.json({
      settings: toRow(
        writeUserSettings(user.id, {
          defaultModelId: data.default_model_id,
          defaultModelProvider: data.default_model_provider,
          systemPrompt: data.system_prompt,
        }),
      ),
    });
  } catch (error) {
    return handleRouteError(error, "Unable to load user settings.");
  }
}

export async function PUT(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    defaultModelId?: unknown;
    defaultModelProvider?: unknown;
    followMode?: unknown;
    systemPrompt?: unknown;
  } | null;

  const hasModel =
    body?.defaultModelId !== undefined || body?.defaultModelProvider !== undefined;
  const hasSystemPrompt = body?.systemPrompt !== undefined;
  const hasFollowMode = typeof body?.followMode === "boolean";

  if (!hasModel && !hasSystemPrompt && !hasFollowMode) {
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
      ...(hasFollowMode ? { followMode: body?.followMode as boolean } : {}),
      ...(hasSystemPrompt ? { systemPrompt: systemPrompt ?? null } : {}),
    });

    // A follow-mode-only save has nothing to mirror, and an upsert naming no
    // column but the key would touch `updated_at` for a field Postgres does
    // not hold.
    if (!hasModel && !hasSystemPrompt) {
      return Response.json({ settings: toRow(saved) });
    }

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

    // `data` is the mirror's echo and has no `follow_mode` column, so the
    // field is taken from the disk write that is authoritative for it. Without
    // this a model save would answer with it absent and reset the client's
    // copy to the default.
    return Response.json({
      settings: { ...data, follow_mode: saved.followMode },
    });
  } catch (error) {
    return handleRouteError(error, "Unable to save settings.");
  }
}
