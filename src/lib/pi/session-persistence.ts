import { createAdminClient } from "@/lib/supabase-admin";
import { toAsciiJson, toJson } from "./json-sanitize";
import type { Json } from "@/types/database.types";
import type { WorkflowSnapshot } from "@/types/workflow";
import { statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PI_SESSION_DIR, PI_WORKSPACE_ROOT } from "./runtime-config";
import { writeSessionMeta } from "./session-meta";
import { listRunningWorkflowRuns, upsertWorkflowRun } from "./workflow-run-index";

/**
 * The fields of a pi session entry this table stores. Pi's own entry type
 * carries far more; callers hand their entries over as this shape, so it is
 * exported rather than restated at each call site.
 */
export type PiSessionEntry = {
  id: string;
  parentId: string | null;
  timestamp: string;
  type: string;
};

export const updateSessionTitle = async (
  semlaSessionId: string,
  title: string,
) => {
  writeSessionMeta(semlaSessionId, { title });

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

/**
 * A short, loggable description of a Supabase failure.
 *
 * When the origin is unreachable, PostgREST hands back a Cloudflare error page,
 * so `error.message` is several kilobytes of HTML. Interpolated straight into an
 * Error it buries the one useful fact — that the database was unreachable — in
 * markup, and floods the log with it on every retry of a snapshot that is
 * written many times a second.
 */
export const describeDbError = (message: string): string => {
  const trimmed = message.trim();
  if (!/^<!DOCTYPE|^<html/i.test(trimmed)) {
    return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
  }

  const title = /<title>([^<]+)<\/title>/i.exec(trimmed)?.[1]?.trim();
  return title ? `upstream returned an error page: ${title}` : "upstream returned an error page";
};

export const persistWorkflowSnapshot = async (
  semlaSessionId: string,
  snapshot: WorkflowSnapshot,
  mode: "background" | "foreground",
) => {
  if (!snapshot.runId) return;

  const status =
    snapshot.runningCount > 0
      ? "running"
      : snapshot.errorCount > 0
        ? "failed"
        : "completed";

  // Index only: the snapshot itself is already on disk in the run file, which
  // the workflows route prefers anyway.
  upsertWorkflowRun(semlaSessionId, snapshot.runId, { mode, status });

  const admin = createAdminClient();

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
    throw new Error(`Unable to persist workflow run: ${describeDbError(error.message)}`);
  }
};

export const persistBackgroundWorkflowStart = async (
  semlaSessionId: string,
  runId: string,
) => {
  upsertWorkflowRun(semlaSessionId, runId, { mode: "background", status: "running" });

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
    throw new Error(`Unable to persist workflow run: ${describeDbError(error.message)}`);
  }
};

export const createSessionFile = async (
  semlaSessionId: string,
  entries: Array<{ created_at: string; id: string; payload: Json }>,
) => {
  await mkdir(PI_SESSION_DIR, { recursive: true });

  const sessionFile = join(PI_SESSION_DIR, `${semlaSessionId}.jsonl`);

  // The file is the record, not a cache of the database. Rebuilding it from
  // Postgres on every start made the transcript only as good as the last
  // successful query: with Supabase unreachable, fetchPersistedEntries returns
  // nothing and this wrote a bare header over the whole conversation. Entries
  // are still mirrored to Postgres, and a session that predates the file — or
  // whose file was lost — is seeded from there below.
  try {
    if (statSync(sessionFile).size > 0) return sessionFile;
  } catch {
    // No file yet: seed it.
  }

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

/**
 * How many entries go in one upsert. Large enough that a long conversation is
 * one or two round trips, small enough that a single failure re-sends little.
 */
const ENTRY_BATCH = 250;

/**
 * Mirror a run of entries to Postgres in as few round trips as possible.
 *
 * `persistEntry` costs two round trips per entry — the upsert and the leaf
 * pointer — and the turn used to call it once per entry in the whole
 * conversation. A ten-turn session in .semla-debug spent 337 seconds across
 * 3,009 of those calls re-writing rows that had not changed, and the cost grew
 * with every turn.
 *
 * Here the rows go up together and the leaf pointer is written once, from the
 * last entry. `parent_entry_id` is a self-referencing foreign key, but it is
 * enforced by an AFTER ROW trigger that fires at the end of the statement, so
 * every row in a batch is visible to every other by the time it is checked.
 *
 * On failure the batch is retried one entry at a time through `persistEntry`,
 * which keeps the ASCII-payload degradation that exists so one unstorable
 * entry cannot take the rest of the turn — including the assistant's answer —
 * down with it.
 */
export const persistEntries = async (
  piSessionId: string,
  entries: readonly PiSessionEntry[],
): Promise<void> => {
  if (entries.length === 0) return;

  const admin = createAdminClient();

  for (let i = 0; i < entries.length; i += ENTRY_BATCH) {
    const batch = entries.slice(i, i + ENTRY_BATCH);
    const { error } = await admin.from("pi_session_entries").upsert(
      batch.map((entry) => ({
        event_type: entry.type,
        id: entry.id,
        parent_entry_id: entry.parentId,
        payload: toJson({ entry }),
        pi_session_id: piSessionId,
      })),
      { onConflict: "id" },
    );

    if (error) {
      console.warn(
        `[pi:session-persistence] Batch of ${batch.length} entries rejected: ${describeDbError(error.message)} — retrying individually`,
      );
      for (const entry of batch) {
        await persistEntry(piSessionId, entry);
      }
      // persistEntry already moved the leaf for each of these.
      continue;
    }

    const leaf = batch[batch.length - 1]!;
    const { error: updateError } = await admin
      .from("pi_sessions")
      .update({
        active_leaf_entry_id: leaf.id,
        updated_at: new Date().toISOString(),
      })
      .eq("id", piSessionId);

    if (updateError) {
      throw new Error(
        `Unable to update Pi session: ${describeDbError(updateError.message)}`,
      );
    }
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
  semlaSessionId: string,
  runId: string,
  status: "completed" | "failed" = "completed",
) => {
  upsertWorkflowRun(semlaSessionId, runId, { status });

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
  writeSessionMeta(semlaSessionId, { isRunning: running });

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
  // The index knows this without a query, and knows it when the database does
  // not answer at all.
  const onDisk = listRunningWorkflowRuns(semlaSessionId);
  if (onDisk.length > 0) return onDisk.map((run) => ({ run_id: run.run_id }));

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
