/**
 * Read a session's transcript from disk.
 *
 * Pi appends every entry to `<PI_SESSION_DIR>/<sessionId>.jsonl` as it happens,
 * so the file is a complete record that exists before Postgres has been told
 * anything. Postgres held the copy the UI read, which meant the transcript was
 * only as available as the database: an outage emptied the conversation view of
 * a session whose history was sitting on disk the whole time.
 *
 * Each line is exactly the object stored as `payload.entry` in
 * `pi_session_entries`, so both sources reduce to the same shape and the
 * transform over them stays one implementation.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { PI_SESSION_DIR } from "@/lib/pi/runtime-config";

/** The row shape getTranscript consumes, from either source. */
export interface TranscriptRow {
  created_at: string;
  id: string;
  payload: { entry: { id?: string; timestamp?: string; type?: string } };
}

interface SessionFileEntry {
  id?: string;
  timestamp?: string;
  type?: string;
}

export function sessionFilePath(semlaSessionId: string, dir = PI_SESSION_DIR): string {
  return join(dir, `${semlaSessionId}.jsonl`);
}

/**
 * Message entries from a session file, or null when there is no file to read.
 *
 * Null rather than an empty array on purpose: "no file" means fall back to
 * Postgres, while a file containing no messages is a real, empty transcript.
 * Unparseable lines are skipped rather than failing the read — a truncated
 * final line loses one entry, not the conversation.
 */
export function readSessionEntries(
  semlaSessionId: string,
  dir = PI_SESSION_DIR,
): TranscriptRow[] | null {
  const path = sessionFilePath(semlaSessionId, dir);

  try {
    if (statSync(path).size === 0) return null;
  } catch {
    return null;
  }

  const rows: TranscriptRow[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;

    let entry: SessionFileEntry;
    try {
      entry = JSON.parse(line) as SessionFileEntry;
    } catch {
      continue;
    }

    // The header line describes the session; only message entries are
    // transcript, matching the event_type filter on the Postgres side.
    if (entry.type !== "message" || !entry.id) continue;

    rows.push({
      created_at: entry.timestamp ?? "",
      id: entry.id,
      payload: { entry },
    });
  }

  return rows;
}
