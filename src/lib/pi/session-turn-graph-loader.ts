/**
 * Loading a session's turn graph, from disk when there is one.
 *
 * Mirrors transcript.ts's getTranscript(): disk is complete and available
 * without a database, Postgres is the mirror read only for sessions recorded
 * before the file became authoritative or whose file is gone. The one
 * difference is what each reads \u2014 the transcript reader walks down to the
 * live path and drops everything else; this needs the whole tree, abandoned
 * branches included, which is why it goes through readAllSessionEntries /
 * every row rather than readSessionEntries / liveMessageRows.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/types/database.types";
import {
  readAllSessionEntries,
  type SessionFileEntry,
} from "@/lib/pi/session-file";
import { buildTurnGraph, type TurnGraph } from "@/lib/pi/session-turn-graph";

/** The row shape a DB-sourced entry reduces to, matching SessionFileEntry. */
type EntryRow = {
  payload: { entry?: SessionFileEntry };
};

export async function getSessionTurnGraph(
  supabase: SupabaseClient<Database>,
  semlaSessionId: string,
): Promise<TurnGraph> {
  const fromDisk = readAllSessionEntries(semlaSessionId);
  if (fromDisk) return buildTurnGraph(fromDisk);

  const { data: piSession, error: sessionError } = await supabase
    .from("pi_sessions")
    .select("id")
    .eq("semla_session_id", semlaSessionId)
    .maybeSingle();

  if (sessionError) {
    throw new Error(`Unable to load Pi session: ${sessionError.message}`);
  }

  if (!piSession) {
    return { edges: [], nodes: [], truncated: false };
  }

  const { data: rows, error: entriesError } = await supabase
    .from("pi_session_entries")
    .select("payload")
    .eq("pi_session_id", piSession.id)
    .order("created_at");

  if (entriesError) {
    throw new Error(`Unable to load Pi transcript: ${entriesError.message}`);
  }

  const entries = (rows as unknown as EntryRow[])
    .map((row) => row.payload?.entry)
    .filter((entry): entry is SessionFileEntry => Boolean(entry?.id));

  return buildTurnGraph(entries);
}
