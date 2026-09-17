/**
 * Postgres mirror of session artifacts.
 *
 * Disk (artifact-store.ts) is authoritative. This upserts the same rows into
 * `session_artifacts` so the record survives the machine's
 * `.semla-artifacts` directory — the same relationship session_projects has
 * to session-meta.ts, and for the same reason: a reader that disagrees with
 * disk defers to disk.
 *
 * `payload` is the artifact's own JSON, minus the fields already promoted to
 * columns — see `toPayload`. Keeping the payload's shape in
 * `artifact-types.ts` rather than in this file's mapping is deliberate: this
 * module strips, it does not redefine.
 *
 * This throws, like every other function in session-persistence.ts. Callers
 * fire it through `queueArtifacts`/`drainArtifacts` (artifact-persist-queue.ts),
 * never as a bare `void` — see fire-and-forget-writes.test.ts.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { describeDbError } from "@/lib/pi/session/session-persistence";
import type { Json } from "@/types/database.types";
import type { SessionArtifact } from "@/lib/artifacts/artifact-types";

/**
 * How many rows go in one upsert. Matches ENTRY_BATCH's reasoning in
 * session-persistence.ts: large enough that a session's whole backlog is one
 * or two round trips, small enough that a failure resends little.
 */
export const ARTIFACT_BATCH = 100;

/**
 * The columns promoted out of an artifact, stripped from what goes into
 * `payload`. Listed once here so the mapping and the "what's left over" test
 * in session-artifacts-schema.test.ts read the same set.
 */
const PROMOTED_FIELDS = [
  "key",
  "sessionId",
  "roundId",
  "toolCallId",
  "toolName",
  "attribution",
  "projectPath",
  "createdAt",
  "turnId",
] as const;

/**
 * The artifact's own fields, minus everything already promoted to a column.
 *
 * `structuredClone` before deleting: the artifact objects here are the same
 * ones appended to disk moments earlier, and this must not mutate them.
 */
export function toPayload(artifact: SessionArtifact): Json {
  const clone = structuredClone(artifact) as unknown as Record<string, unknown>;
  for (const field of PROMOTED_FIELDS) delete clone[field];
  return clone as Json;
}

/**
 * `project_path` is `null` for a spec artifact (see `SpecArtifact` in
 * artifact-types.ts) and non-null for every other kind — the column allows
 * both since 20260911000000_add_spec_artifacts.sql widened it (not applied,
 * matched here in TypeScript by hand-editing database.types.ts; see
 * session-artifacts-schema.test.ts).
 */
function toRow(sessionId: string, artifact: SessionArtifact) {
  return {
    artifact_key: artifact.key,
    attribution: artifact.attribution,
    kind: artifact.kind,
    payload: toPayload(artifact),
    project_path: artifact.projectPath,
    round_id: artifact.roundId,
    session_id: sessionId,
    tool_call_id: artifact.toolCallId,
    tool_name: artifact.toolName,
    turn_id: artifact.turnId,
  };
}

/**
 * Upsert on (session_id, artifact_key) — the same identity that makes the
 * disk JSONL idempotent on re-capture. Throws on failure; callers use
 * `queueArtifacts`/`drainArtifacts`, never a bare `await`/`void` on the
 * critical path.
 */
export async function persistArtifacts(
  sessionId: string,
  artifacts: readonly SessionArtifact[],
): Promise<void> {
  if (artifacts.length === 0) return;

  const admin = createAdminClient();

  for (let i = 0; i < artifacts.length; i += ARTIFACT_BATCH) {
    const batch = artifacts.slice(i, i + ARTIFACT_BATCH);
    const { error } = await admin
      .from("session_artifacts")
      .upsert(
        batch.map((artifact) => toRow(sessionId, artifact)),
        { onConflict: "session_id,artifact_key" },
      );

    if (error) {
      throw new Error(
        `Unable to persist ${batch.length} artifact(s): ${describeDbError(error.message)}`,
      );
    }
  }
}
