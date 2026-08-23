import { createAdminClient } from "@/lib/supabase-admin";
import type { Json } from "@/types/database.types";
import type { WorkflowSnapshot } from "@/types/workflow";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PI_SESSION_DIR, PI_WORKSPACE_ROOT } from "./runtime-config";

type PiSessionEntry = {
  id: string;
  parentId: string | null;
  timestamp: string;
  type: string;
};

export const updateSessionTitle = async (
  semlaSessionId: string,
  title: string,
) => {
  const admin = createAdminClient();
  await admin
    .from("sessions")
    .update({ title })
    .eq("id", semlaSessionId);
};

export const toJson = (value: unknown): Json =>
  JSON.parse(JSON.stringify(value)) as Json;

export const persistWorkflowSnapshot = async (
  semlaSessionId: string,
  snapshot: WorkflowSnapshot,
  mode: "background" | "foreground",
) => {
  if (!snapshot.runId) return;

  const admin = createAdminClient();
  const status =
    snapshot.runningCount > 0
      ? "running"
      : snapshot.errorCount > 0
        ? "failed"
        : "completed";

  const { error } = await admin.from("workflow_runs").upsert(
    {
      mode,
      run_id: snapshot.runId,
      semla_session_id: semlaSessionId,
      snapshot: toJson(snapshot),
      status,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "run_id" },
  );

  if (error) {
    throw new Error(`Unable to persist workflow run: ${error.message}`);
  }
};

export const persistBackgroundWorkflowStart = async (
  semlaSessionId: string,
  runId: string,
) => {
  const admin = createAdminClient();
  const { error } = await admin.from("workflow_runs").upsert(
    {
      mode: "background",
      run_id: runId,
      semla_session_id: semlaSessionId,
      snapshot: {},
      status: "running",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "run_id" },
  );

  if (error) {
    throw new Error(`Unable to persist workflow run: ${error.message}`);
  }
};

export const createSessionFile = async (
  semlaSessionId: string,
  entries: Array<{ created_at: string; id: string; payload: Json }>,
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
    "utf8",
  );

  return sessionFile;
};

export const ensurePiSession = async (
  semlaSessionId: string,
  configuredModel: { modelId: string; provider: string; model: unknown; runtime: unknown },
) => {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("pi_sessions")
    .upsert(
      {
        model_id: configuredModel.modelId,
        model_provider: configuredModel.provider,
        semla_session_id: semlaSessionId,
        workspace_root: PI_WORKSPACE_ROOT,
      },
      { onConflict: "semla_session_id" },
    )
    .select()
    .single();

  if (error) {
    throw new Error(`Unable to initialize Pi session: ${error.message}`);
  }

  return data;
};

export const persistEntry = async (piSessionId: string, entry: PiSessionEntry) => {
  const admin = createAdminClient();
  const { error: entryError } = await admin.from("pi_session_entries").upsert(
    {
      event_type: entry.type,
      id: entry.id,
      parent_entry_id: entry.parentId,
      payload: toJson({ entry }),
      pi_session_id: piSessionId,
    },
    { onConflict: "id" },
  );

  if (entryError) {
    throw new Error(
      `Unable to persist Pi session entry: ${entryError.message}`,
    );
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

export const fetchPersistedEntries = async (piSessionId: string) => {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("pi_session_entries")
    .select("created_at, id, payload")
    .eq("pi_session_id", piSessionId)
    .order("created_at");

  if (error) {
    throw new Error(`Unable to restore Pi session: ${error.message}`);
  }

  return data;
};

export const finalizeBackgroundRun = async (runId: string) => {
  const admin = createAdminClient();
  await admin
    .from("workflow_runs")
    .update({ status: "completed", updated_at: new Date().toISOString() })
    .eq("run_id", runId)
    .eq("status", "running");
};
