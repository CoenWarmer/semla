/**
 * Creating a session's record, wherever the request to create it arrives.
 *
 * Two routes need this. `POST /api/sessions` is the explicit one, and the
 * prompt route creates the session it is being asked to prompt when there is
 * no record yet — which is how starting a session costs one request instead of
 * two, with nothing between navigating and the agent beginning to work.
 *
 * The order matters and is not the obvious one. Postgres is a mirror for
 * *reading* a session, so the instinct is to write disk first and let the row
 * follow. But `sessions` is a parent row: `pi_sessions.semla_session_id` is
 * `not null references sessions(id)`, so the first turn cannot write anything
 * until it exists. A session on disk with no row is broken rather than
 * degraded, so the row is written first and its failure is the caller's
 * failure.
 */

import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { parseRequestedSessionId } from "@/lib/pi/session-id";
import {
  hasTranscript,
  readSessionMeta,
  writeSessionMeta,
} from "@/lib/pi/session-meta";
import { attachProject } from "@/lib/pi/session-project-links";
import { mirrorSessionProjects } from "@/lib/pi/session-project-mirror";
import type { Database } from "@/types/database.types";

/** Postgres's unique-violation code. */
const UNIQUE_VIOLATION = "23505";

export type SessionCreateRequest = {
  /**
   * The id the session should have. Minted by the client so /sessions/new can
   * navigate — and prefetch — before this request is sent; validated because it
   * becomes a primary key and a path. Anything unusable is replaced.
   */
  id?: unknown;
  project?: unknown;
  title?: unknown;
};

export type SessionCreateResult =
  | { id: string; kind: "created" }
  /** Something already owns this id, so there is nothing to create. */
  | { id: string; kind: "exists" }
  | { kind: "failed"; message: string };

/**
 * Whether this machine already has a record of the session.
 *
 * `dir` is injectable for the same reason it is on the readers underneath: a
 * test must not be able to write into the real session directory.
 */
export const sessionExistsOnDisk = (id: string, dir?: string): boolean =>
  readSessionMeta(id, dir) !== null || hasTranscript(id, dir);

export const readSessionCreateRequest = (body: unknown) => {
  const source = (body ?? {}) as SessionCreateRequest;
  const title =
    typeof source.title === "string" && source.title.trim()
      ? source.title.trim()
      : "New Session";
  // Workspace-relative, which for a first-level project is just its name. The
  // absolute path this used to take was only ever turned back into a relative
  // one, and it meant the wire carried a path that means nothing off this host.
  const project =
    typeof source.project === "string" && source.project.trim()
      ? source.project.trim()
      : null;

  return { id: parseRequestedSessionId(source.id), project, title };
};

export async function createSession({
  client,
  dir,
  id: requestedId,
  project,
  title,
  userId,
}: {
  client: SupabaseClient<Database>;
  /** Session directory, injectable so a test writes somewhere disposable. */
  dir?: string;
  /** Null asks for an id to be minted here. */
  id: string | null;
  project: string | null;
  title: string;
  userId: string;
}): Promise<SessionCreateResult> {
  // Minted here rather than by Postgres when the caller has no preference:
  // nothing about naming a session needs the database, and reading the name
  // back out of the insert made the disk record and the response wait on it.
  const id = requestedId ?? randomUUID();

  // Checked here rather than trusted from the caller, because this is where the
  // id becomes a filename: `<session dir>/<id>.json`. One caller takes it from
  // a route parameter, and an id that could climb out of that directory must
  // not depend on that route remembering to validate it.
  if (!parseRequestedSessionId(id)) {
    return {
      kind: "failed",
      message: "A session id must be a uuid.",
    };
  }

  // Checked against the authoritative store rather than left to the table's
  // primary key. The id can come from a client, and the insert would only catch
  // a duplicate after writeSessionMeta had overwritten the record of whatever
  // session owns it.
  if (sessionExistsOnDisk(id, dir)) return { id, kind: "exists" };

  const { error } = await client
    .from("sessions")
    .insert({ id, title, user_id: userId });

  if (error) {
    // Two requests raced for the same new session — the prompt route creating
    // one, say, while an explicit create was already in flight. The row exists,
    // which is all the caller wanted.
    if (error.code === UNIQUE_VIOLATION) return { id, kind: "exists" };

    console.error("[session-create] Failed to create session:", error);
    return { kind: "failed", message: error.message };
  }

  // One timestamp for the record and the link it carries, so the session and
  // its first project do not disagree about when they began.
  const createdAt = new Date().toISOString();

  // A project chosen from a card is an explicit link, and the anchor.
  const projects = project
    ? attachProject([], {
        at: createdAt,
        origin: "explicit",
        path: project,
        primary: true,
      })
    : [];

  // Recorded on disk too, so the session is findable without the database —
  // and it is what every reader consults first.
  writeSessionMeta(id, { createdAt, projects, title, userId }, dir);

  // Not awaited, and skipped when there is nothing to mirror: it replaces a
  // session's links by deleting them first, which for a session created one
  // line ago can only delete nothing. Best-effort by contract, and the disk
  // write above has already succeeded.
  if (projects.length > 0) void mirrorSessionProjects(id, projects);

  return { id, kind: "created" };
}
