import { createAdminClient } from "@/lib/supabase-admin";
import { toAsciiJson, toJson } from "./json-sanitize";
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
  const { error } = await admin
    .from("sessions")
    .update({ title })
    .eq("id", semlaSessionId);

  if (error) {
    console.error(
      `[pi:session-persistence] Unable to update session title for ${semlaSessionId}:`,
      error,
    );
  }
};

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
  const row = {
    event_type: entry.type,
    id: entry.id,
    parent_entry_id: entry.parentId,
    pi_session_id: piSessionId,
  };

  const { error: entryError } = await admin
    .from("pi_session_entries")
    .upsert({ ...row, payload: toJson({ entry }) }, { onConflict: "id" });

  if (entryError) {
    // parent_entry_id is a self-referencing foreign key and entries are written
    // in order, so one unstorable entry makes every later entry of the turn
    // unstorable too — including the assistant's final answer. Degrade the
    // characters rather than dropping the tail of the conversation.
    console.error(
      `[pi:session-persistence] Entry ${entry.id} (${entry.type}) rejected: ${entryError.message} — retrying with ASCII-only payload`,
    );

    const { error: retryError } = await admin
      .from("pi_session_entries")
      .upsert({ ...row, payload: toAsciiJson({ entry }) }, { onConflict: "id" });

    if (retryError) {
      throw new Error(
        `Unable to persist Pi session entry: ${retryError.message}`,
      );
    }
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

export const finalizeBackgroundRun = async (
  runId: string,
  status: "completed" | "failed" = "completed",
) => {
  const admin = createAdminClient();
  const { error } = await admin
    .from("workflow_runs")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("run_id", runId)
    .eq("status", "running");

  if (error) {
    console.error(
      `[pi:session-persistence] Unable to finalize background run ${runId}:`,
      error,
    );
  }
};

export const setSessionRunning = async (
  semlaSessionId: string,
  running: boolean,
): Promise<void> => {
  const admin = createAdminClient();
  const { error } = await admin
    .from("sessions")
    .update({ is_running: running })
    .eq("id", semlaSessionId);

  if (error) {
    console.error(
      `[pi:session-persistence] Unable to set is_running=${String(running)} for ${semlaSessionId}:`,
      error,
    );
  }
};

export const fetchStuckBackgroundRuns = async (
  semlaSessionId: string,
): Promise<Array<{ run_id: string }>> => {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("workflow_runs")
    .select("run_id")
    .eq("semla_session_id", semlaSessionId)
    .eq("status", "running");

  if (error) {
    console.error(
      `[pi:session-persistence] Unable to fetch stuck background runs: ${error.message}`,
    );
    return [];
  }

  return data ?? [];
};
