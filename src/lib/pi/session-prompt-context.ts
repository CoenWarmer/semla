import { buildMemoryContextBlock } from "@/lib/pi/prompts";
import { DEFAULT_SYSTEM_PROMPT } from "@/lib/pi/system-prompt";
import { sessionProjects } from "@/lib/pi/session-project";
import { readUserSettings } from "@/lib/user-settings-store";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface SessionPromptContext {
  /** Workspace-relative, anchor first. Empty when the session has none. */
  projects: string[];
  /** Exactly the system prompt a turn would be sent with. */
  systemPrompt: string;
  /**
   * The model a turn would use, before a session has recorded one of its own.
   * Null when the user has never chosen a default.
   */
  defaultModel: { provider: string; modelId: string } | null;
}

/**
 * Resolve the system prompt and project a session's next turn would use.
 *
 * Shared so that anything measuring the prompt measures the same string the
 * agent is actually given. Counting only the user's override — which is what
 * the composition bar did — reports a system prompt of zero for everyone who
 * has never set one, which is most sessions and all new ones.
 *
 * Both lookups read from disk first: a database that cannot answer would
 * otherwise silently downgrade the session to the default prompt with no
 * project attached.
 */
export async function resolveSessionPromptContext(
  supabase: SupabaseClient,
  sessionId: string,
  userId: string,
): Promise<SessionPromptContext> {
  const localSettings = readUserSettings(userId);

  const [{ data: settingsData }, links] = await Promise.all([
    localSettings
      ? Promise.resolve({ data: null })
      : supabase
          .from("user_settings")
          .select("system_prompt, default_model_id, default_model_provider")
          .eq("user_id", userId)
          .maybeSingle(),
    // Disk first with its own fallbacks; see sessionProjects.
    sessionProjects(sessionId, supabase as never),
  ]);

  const projects = links.map((link) => link.path);
  const basePrompt =
    localSettings?.systemPrompt ??
    settingsData?.system_prompt ??
    DEFAULT_SYSTEM_PROMPT;

  const provider =
    localSettings?.defaultModelProvider ?? settingsData?.default_model_provider;
  const modelId = localSettings?.defaultModelId ?? settingsData?.default_model_id;

  return {
    projects,
    systemPrompt: `${basePrompt}\n\n---\n\n${buildMemoryContextBlock(projects)}`,
    defaultModel: provider && modelId ? { provider, modelId } : null,
  };
}
