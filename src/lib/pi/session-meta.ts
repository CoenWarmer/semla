/**
 * Session metadata on disk, beside the transcript it describes.
 *
 * `sessions` in Postgres holds what the UI needs to *find* a session — title,
 * goal, project, whether it is running. Without it a transcript is readable but
 * unreachable: the list is empty and the page has no title. Keeping the same
 * fields in `<PI_SESSION_DIR>/<id>.json` makes the pair self-describing, so a
 * session directory is a complete record rather than half of one.
 *
 * Postgres stays the mirror. Writes go to both; the disk write is the one that
 * has to succeed.
 *
 * One file per session rather than an index: an index is a second thing to keep
 * in sync, and the failure mode — a session that exists but is not listed — is
 * exactly what this is meant to prevent.
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { PI_SESSION_DIR } from "@/lib/pi/runtime-config";

export interface SessionMeta {
  id: string;
  title: string | null;
  goal: string | null;
  projectPath: string | null;
  isRunning: boolean;
  createdAt: string;
  /** Who the session belongs to. Authorisation still consults Postgres. */
  userId: string | null;
}

const metaPath = (id: string, dir: string) => join(dir, `${id}.json`);

const blank = (id: string): SessionMeta => ({
  id,
  title: null,
  goal: null,
  projectPath: null,
  isRunning: false,
  createdAt: new Date().toISOString(),
  userId: null,
});

export function readSessionMeta(
  id: string,
  dir = PI_SESSION_DIR,
): SessionMeta | null {
  try {
    const raw = readFileSync(metaPath(id, dir), "utf8");
    const parsed = JSON.parse(raw) as Partial<SessionMeta>;
    // Spread over a blank so a record written by an older version is still
    // usable rather than throwing on a field that did not exist yet.
    return { ...blank(id), ...parsed, id };
  } catch {
    return null;
  }
}

/**
 * Merge fields into a session's record, creating it if absent.
 *
 * Read-modify-write is safe enough here: a session is written by the one
 * process that owns it, and the fields are last-writer-wins by nature.
 */
export function writeSessionMeta(
  id: string,
  patch: Partial<Omit<SessionMeta, "id">>,
  dir = PI_SESSION_DIR,
): SessionMeta {
  mkdirSync(dir, { recursive: true });
  const next: SessionMeta = { ...(readSessionMeta(id, dir) ?? blank(id)), ...patch, id };
  writeFileSync(metaPath(id, dir), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

/**
 * Every session with a record on disk, newest first.
 *
 * Sessions whose metadata predates this store have no file yet and are absent;
 * the caller falls back to Postgres and seeds them.
 */
export function listSessionMeta(dir = PI_SESSION_DIR): SessionMeta[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const sessions: SessionMeta[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const meta = readSessionMeta(entry.replace(/\.json$/, ""), dir);
    if (meta) sessions.push(meta);
  }

  return sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Remove a session's record and transcript.
 *
 * Deleting a session has always removed its entries from Postgres by cascade;
 * now that the same data is on disk and is the copy that is read, leaving it
 * behind means the session comes back — the sidebar polls the directory, so a
 * record nobody deleted is a session nobody can get rid of.
 *
 * Irreversible: the transcript is the conversation, and this is what deleting
 * a session means.
 */
export function deleteSessionFiles(id: string, dir = PI_SESSION_DIR): void {
  for (const suffix of [".json", ".jsonl"]) {
    try {
      rmSync(join(dir, `${id}${suffix}`), { force: true });
    } catch {
      // Already gone, or never written.
    }
  }
}

/** True when a session has a transcript on disk, whatever Postgres knows. */
export function hasTranscript(id: string, dir = PI_SESSION_DIR): boolean {
  try {
    return statSync(join(dir, `${id}.jsonl`)).size > 0;
  } catch {
    return false;
  }
}
