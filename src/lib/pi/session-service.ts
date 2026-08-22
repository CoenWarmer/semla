import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createAdminClient } from "@/lib/supabase-admin";
import {
  PI_SESSION_DIR,
  PI_TOOLS,
  PI_WORKSPACE_ROOT,
  getPiRuntimeConfig,
} from "@/lib/pi/runtime-config";
import type { Json } from "@/types/database.types";

type PiSessionEntry = {
  id: string;
  parentId: string | null;
  timestamp: string;
  type: string;
};

type PiSessionEvent =
  | { delta: string; type: "assistant-delta" }
  | { toolName: string; type: "tool-start" }
  | { toolName: string; type: "tool-end" }
  | { message: string; type: "error" }
  | { type: "complete" };

const toJson = (value: unknown): Json =>
  JSON.parse(JSON.stringify(value)) as Json;

const assertSandboxedRuntime = () => {
  const { hostDevelopmentEnabled, sandboxed } = getPiRuntimeConfig();

  if (!sandboxed && !hostDevelopmentEnabled) {
    throw new Error(
      "Pi must run inside the Semla sandbox. For local development only, set PI_ALLOW_HOST_DEV=true."
    );
  }
};

const getConfiguredModel = async ({
  modelId,
  provider,
}: {
  modelId: string;
  provider: string;
}) => {
  const runtime = await ModelRuntime.create({ refreshOnCreate: false });
  const apiKey = process.env.PI_MODEL_API_KEY;

  if (apiKey) {
    await runtime.setRuntimeApiKey(provider, apiKey);
  }

  const model = runtime.getModel(provider, modelId);

  if (!model) {
    throw new Error(`Pi model ${provider}/${modelId} is not available.`);
  }

  return { model, modelId, provider, runtime };
};

const createSessionFile = async (
  semlaSessionId: string,
  entries: Array<{ created_at: string; id: string; payload: Json }>
) => {
  await mkdir(PI_SESSION_DIR, { recursive: true });

  const sessionFile = join(PI_SESSION_DIR, `${semlaSessionId}.jsonl`);
  const sessionHeader = {
    cwd: PI_WORKSPACE_ROOT,
    id: semlaSessionId,
    timestamp: new Date().toISOString(),
    type: "session",
    version: 3,
  };

  const serializedEntries = entries.flatMap((entry) => {
    const record = entry.payload as { entry?: PiSessionEntry };
    return record.entry ? [record.entry] : [];
  });

  await writeFile(
    sessionFile,
    [sessionHeader, ...serializedEntries]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
    "utf8"
  );

  return sessionFile;
};

const ensurePiSession = async (
  semlaSessionId: string,
  modelSelection: { modelId: string; provider: string }
) => {
  const admin = createAdminClient();
  const configuredModel = await getConfiguredModel(modelSelection);
  const { data, error } = await admin
    .from("pi_sessions")
    .upsert(
      {
        model_id: configuredModel.modelId,
        model_provider: configuredModel.provider,
        semla_session_id: semlaSessionId,
        workspace_root: PI_WORKSPACE_ROOT,
      },
      { onConflict: "semla_session_id" }
    )
    .select()
    .single();

  if (error) {
    throw new Error(`Unable to initialize Pi session: ${error.message}`);
  }

  return { configuredModel, piSession: data };
};

const persistEntry = async (
  piSessionId: string,
  entry: PiSessionEntry
) => {
  const admin = createAdminClient();
  const { error: entryError } = await admin
    .from("pi_session_entries")
    .upsert(
      {
        event_type: entry.type,
        id: entry.id,
        parent_entry_id: entry.parentId,
        payload: toJson({ entry }),
        pi_session_id: piSessionId,
      },
      { onConflict: "id" }
    )

  if (entryError) {
    throw new Error(`Unable to persist Pi session entry: ${entryError.message}`);
  }

  const { error: updateError } = await admin
    .from("pi_sessions")
    .update({
      active_leaf_entry_id: entry.id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", piSessionId);

  if (updateError) {
    throw new Error(`Unable to update Pi session: ${updateError.message}`);
  }
};

export const runPiPrompt = async ({
  model,
  onEvent,
  semlaSessionId,
  text,
}: {
  model: { modelId: string; provider: string };
  onEvent: (event: PiSessionEvent) => void;
  semlaSessionId: string;
  text: string;
}) => {
  assertSandboxedRuntime();

  const { configuredModel, piSession } = await ensurePiSession(
    semlaSessionId,
    model
  );
  const admin = createAdminClient();
  const { data: persistedEntries, error } = await admin
    .from("pi_session_entries")
    .select("created_at, id, payload")
    .eq("pi_session_id", piSession.id)
    .order("created_at");

  if (error) {
    throw new Error(`Unable to restore Pi session: ${error.message}`);
  }

  const sessionFile = await createSessionFile(semlaSessionId, persistedEntries);
  const sessionManager = SessionManager.open(
    sessionFile,
    PI_SESSION_DIR,
    PI_WORKSPACE_ROOT
  );
  const { session } = await createAgentSession({
    cwd: PI_WORKSPACE_ROOT,
    model: configuredModel.model,
    modelRuntime: configuredModel.runtime,
    sessionManager,
    tools: [...PI_TOOLS],
  });

  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;

      if (update.type === "text_delta") {
        onEvent({ delta: update.delta, type: "assistant-delta" });
      }
    }

    if (event.type === "tool_execution_start") {
      onEvent({ toolName: event.toolName, type: "tool-start" });
    }

    if (event.type === "tool_execution_end") {
      onEvent({ toolName: event.toolName, type: "tool-end" });
    }
  });

  try {
    await session.prompt(text);
    await session.agent.waitForIdle();
    for (const entry of session.sessionManager.getEntries()) {
      await persistEntry(piSession.id, entry as PiSessionEntry);
    }
    onEvent({ type: "complete" });
  } finally {
    unsubscribe();
    session.dispose();
  }
};
