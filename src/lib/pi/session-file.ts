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
import { activePath, supersededSiblings } from "@/lib/pi/session-path";

/** The row shape getTranscript consumes, from either source. */
export interface TranscriptRow {
  created_at: string;
  id: string;
  payload: {
    entry: {
      id?: string;
      message?: unknown;
      /** Parent in the session tree. Carried so superseded versions are findable. */
      parentId?: string | null;
      timestamp?: string;
      type?: string;
    };
  };
  /**
   * Earlier versions of this entry — siblings it was branched away from, oldest
   * first. Present only where a prompt was edited.
   */
  superseded?: Array<{ message?: unknown; timestamp?: string }>;
}

interface SessionFileEntry {
  id?: string;
  message?: unknown;
  parentId?: string | null;
  timestamp?: string;
  type?: string;
}

export function sessionFilePath(semlaSessionId: string, dir = PI_SESSION_DIR): string {
  return join(dir, `${semlaSessionId}.jsonl`);
}

/**
 * Message entries on the session's live path, or null when there is no file.
 *
 * Null rather than an empty array on purpose: "no file" means fall back to
 * Postgres, while a file containing no messages is a real, empty transcript.
 * Unparseable lines are skipped rather than failing the read — a truncated
 * final line loses one entry, not the conversation.
 *
 * The file is a tree, so the lines are walked (see session-path.ts) before being
 * filtered to messages, never after. Filtering first would cut the chain
 * wherever a non-message entry — a branch summary, say — sits between two
 * messages, and the walk would stop early at a gap of its own making.
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

  const entries: SessionFileEntry[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;

    let entry: SessionFileEntry;
    try {
      entry = JSON.parse(line) as SessionFileEntry;
    } catch {
      continue;
    }

    // The header describes the session rather than belonging to the tree, which
    // is also how Pi's own getEntries() treats it.
    if (entry.type === "session" || !entry.id) continue;

    entries.push(entry);
  }

  const superseded = supersededSiblings(entries);

  return activePath(entries)
    .filter((entry) => entry.type === "message")
    .map((entry) => {
      // Only message siblings: a prompt branched away from may have a whole
      // abandoned subtree under it, and "what did this say before" wants the
      // prompt, not the replies it drew.
      const earlier = (superseded.get(entry.id as string) ?? []).filter(
        (sibling) => sibling.type === "message",
      );

      return {
        created_at: entry.timestamp ?? "",
        id: entry.id as string,
        payload: { entry },
        ...(earlier.length > 0 ? { superseded: earlier } : {}),
      };
    });
}
