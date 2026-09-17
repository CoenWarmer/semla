/**
 * Disk persistence for session artifacts.
 *
 * JSONL, not per-turn JSON — the reasoning the plan spells out (§4.3):
 * artifacts arrive one tool call at a time from a detached write, while other
 * sessions write their own files, so a per-turn document would be a
 * read-modify-write two concurrent captures of the same turn could race on.
 * `appendFileSync` on one line under the pipe-buffer size needs no lock,
 * preserves arrival order for free, and a truncated tail line from a killed
 * process costs exactly the last artifact — the reader skips unparsable
 * lines. The same trade `.semla-debug/events.jsonl` already makes.
 *
 * Synchronous fs, matching debug-writer.ts and review-turn-mark.ts: ordering
 * inside a callback is guaranteed, and every call here is already inside a
 * detached promise so nothing waits on it. Every function swallows its own
 * errors — best effort, logged, never fatal.
 */

import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { SEMLA_ARTIFACT_DIR } from "@/lib/pi/runtime/runtime-config";
import { sanitizedArtifactKey } from "@/lib/pi/artifacts/artifact-key";
import { ARTIFACT_PATCH_BYTES, type SessionArtifact } from "@/lib/artifacts/artifact-types";

const SESSIONS_DIR = "sessions";
const PATCHES_DIR = "patches";

const sessionDir = (sessionId: string, dir: string) =>
  join(dir, SESSIONS_DIR, sessionId);

const artifactsFile = (sessionId: string, dir: string) =>
  join(sessionDir(sessionId, dir), "artifacts.jsonl");

/** Only the tail of a long-lived session's log is read — see the plan §4.4. */
export const ARTIFACT_TAIL_BYTES = 64 * 1024;

/** Never throws. mkdir -p, then appendFileSync. Errors are logged and dropped. */
export function appendArtifacts(
  sessionId: string,
  artifacts: readonly SessionArtifact[],
  dir: string = SEMLA_ARTIFACT_DIR,
): void {
  if (artifacts.length === 0) return;
  try {
    mkdirSync(sessionDir(sessionId, dir), { recursive: true });
    const lines = artifacts.map((artifact) => `${JSON.stringify(artifact)}\n`).join("");
    appendFileSync(artifactsFile(sessionId, dir), lines, "utf8");
  } catch (error) {
    console.warn(
      `[artifacts] failed to append ${artifacts.length} artifact(s) for session ${sessionId}:`,
      error,
    );
  }
}

/** Never throws. Writes the sidecar; returns the session-relative path or null. */
export function writePatch(
  sessionId: string,
  key: string,
  patch: string,
  dir: string = SEMLA_ARTIFACT_DIR,
): string | null {
  try {
    const truncated =
      Buffer.byteLength(patch, "utf8") > ARTIFACT_PATCH_BYTES
        ? Buffer.from(patch, "utf8").subarray(0, ARTIFACT_PATCH_BYTES).toString("utf8")
        : patch;

    const patchesDir = join(sessionDir(sessionId, dir), PATCHES_DIR);
    mkdirSync(patchesDir, { recursive: true });
    const name = `${sanitizedArtifactKey(key)}.patch`;
    writeFileSync(join(patchesDir, name), truncated, "utf8");
    return join(PATCHES_DIR, name);
  } catch (error) {
    console.warn(`[artifacts] failed to write patch for ${key}:`, error);
    return null;
  }
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  artifacts: SessionArtifact[];
}

const readCache = new Map<string, CacheEntry>();

function parseTail(raw: string): SessionArtifact[] {
  const lines = raw.split("\n").filter((line) => line.trim() !== "");
  const byKey = new Map<string, SessionArtifact>();

  for (const line of lines) {
    try {
      const artifact = JSON.parse(line) as SessionArtifact;
      // A diff written before roles existed has no `role` key at all.
      // Normalized to null on read so every reader can rely on the field
      // being present rather than testing for undefined — the same rule
      // readTurnMark applies to a mark predating turnId.
      if (artifact.kind === "diff") artifact.role = artifact.role ?? null;
      byKey.set(artifact.key, artifact);
    } catch {
      // An unparsable or truncated line costs exactly that one artifact.
    }
  }

  return [...byKey.values()].sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
  );
}

/**
 * Newest-first, deduped by key, unparsable lines skipped.
 *
 * Reads only the last ARTIFACT_TAIL_BYTES of the file, and re-parses only
 * when `statSync` reports the file has changed since the last read — the
 * sidebar's poll sweeps every session every 2s, and an unbounded read of a
 * long-lived session's log would make a decorative chip the most expensive
 * thing in the response.
 */
export function readSessionArtifacts(
  sessionId: string,
  dir: string = SEMLA_ARTIFACT_DIR,
): SessionArtifact[] {
  const file = artifactsFile(sessionId, dir);

  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(file);
  } catch {
    return [];
  }

  const cached = readCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.artifacts;
  }

  try {
    const fd = openSync(file, "r");
    try {
      const readLength = Math.min(stat.size, ARTIFACT_TAIL_BYTES);
      const buffer = Buffer.alloc(readLength);
      readSync(fd, buffer, 0, readLength, stat.size - readLength);
      const artifacts = parseTail(buffer.toString("utf8"));
      readCache.set(file, { artifacts, mtimeMs: stat.mtimeMs, size: stat.size });
      return artifacts;
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    console.warn(`[artifacts] failed to read artifacts for session ${sessionId}:`, error);
    return cached?.artifacts ?? [];
  }
}

/** Read the whole file, ignoring the tail cap — used only by tests. */
export function readSessionArtifactsFull(
  sessionId: string,
  dir: string = SEMLA_ARTIFACT_DIR,
): SessionArtifact[] {
  try {
    return parseTail(readFileSync(artifactsFile(sessionId, dir), "utf8"));
  } catch {
    return [];
  }
}
