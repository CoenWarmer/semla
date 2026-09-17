/**
 * Wiring capture to disk and to the Postgres mirror, for one tool call, and
 * the turn-end residual sweep.
 *
 * Disk (artifact-store.ts) is written first and is authoritative; the
 * Postgres write is queued after, through queueArtifacts, so a slow or failed
 * database round trip never risks the on-disk record — the same ordering
 * session_projects's own writer keeps. queueArtifacts itself does not throw
 * or block: it hands off to artifact-persist-queue.ts's own drain.
 */

import {
  appendArtifacts,
  writePatch,
} from "@/lib/pi/artifacts/artifact-store";
import {
  captureArtifacts,
  type CaptureInput,
} from "@/lib/pi/artifacts/artifact-capture";
import { clearSession, getSnapshot } from "@/lib/pi/artifacts/artifact-snapshot-cache";
import { queueArtifacts } from "@/lib/pi/artifacts/artifact-persist-queue";
import type { DiffArtifact, SessionArtifact } from "@/lib/artifacts/artifact-types";

/**
 * Capture one tool call's artifacts and persist them to disk.
 *
 * Called detached from `onToolEnd` — see session-event-router.ts — so a slow
 * or failing git call never costs the turn.
 */
export async function captureAndRecord(input: CaptureInput): Promise<void> {
  const { artifacts, patches } = await captureArtifacts(input);
  if (artifacts.length === 0) return;

  const withPatchFiles = artifacts.map((artifact) => {
    if (artifact.kind !== "diff") return artifact;
    const patchText = patches.get(artifact.key);
    if (!patchText) return artifact;
    const patchFile = writePatch(input.sessionId, artifact.key, patchText);
    return { ...artifact, patchFile } as DiffArtifact;
  });

  appendArtifacts(input.sessionId, withPatchFiles);
  queueArtifacts(input.sessionId, withPatchFiles);
}

/**
 * At the end of a turn, whatever the chained snapshot cache still holds but
 * no tool call claimed. Compares each project's cached "before" snapshot
 * against a fresh read; anything left over is emitted with
 * `attribution: "turn"`, `toolCallId: null`, `toolName: null`.
 *
 * No tool call id is ever synthesized here — see ArtifactAttribution's
 * docblock. `turnStartedAt` should be the turn's own start time (the
 * `ReviewTurnMark.startedAt` the caller already has), so the key stays
 * deterministic across a re-run of the same residual capture. `turnId` is
 * the same mark's `turnId` (null for a mark written before turn ids
 * existed, or for a turn that never got one) — see ArtifactCore.turnId.
 */
export async function captureTurnResidual(
  sessionId: string,
  turnStartedAt: string,
  turnId: string | null,
  projects: readonly { projectPath: string; root: string }[],
): Promise<void> {
  try {
    const artifacts: SessionArtifact[] = [];
    const patches = new Map<string, string>();

    for (const project of projects) {
      const before = getSnapshot(sessionId, project.projectPath);
      if (!before) continue;

      const result = await captureArtifacts({
        attribution: "turn",
        command: null,
        output: null,
        projects: [project],
        roundId: null,
        sessionId,
        toolCallId: null,
        toolName: null,
        turnId,
        turnStartedAt,
      });
      artifacts.push(...result.artifacts);
      for (const [key, patch] of result.patches) patches.set(key, patch);
    }

    if (artifacts.length > 0) {
      const withPatchFiles = artifacts.map((artifact) => {
        if (artifact.kind !== "diff") return artifact;
        const patchText = patches.get(artifact.key);
        if (!patchText) return artifact;
        const patchFile = writePatch(sessionId, artifact.key, patchText);
        return { ...artifact, patchFile } as DiffArtifact;
      });
      appendArtifacts(sessionId, withPatchFiles);
      queueArtifacts(sessionId, withPatchFiles);
    }
  } finally {
    clearSession(sessionId);
  }
}
