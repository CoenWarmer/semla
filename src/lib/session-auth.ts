import { AUTH_REQUIRED, localUser } from "@/lib/auth-mode";
import { hasTranscript, readSessionMeta } from "@/lib/pi/session-meta";
import { createClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.types";

export type SessionOwnerOptions = {
  /**
   * Answer for a session that has no record yet, instead of refusing it.
   *
   * A session is now created by its own first prompt, so the page mounts and
   * starts polling before anything exists — a captured flow had nine 404s
   * before the turn began, and one of them left the prompt bar reporting no
   * extension tools. The routes those polls hit already handled a missing
   * session (`/status` even says "or be mid-creation"), but this refused first,
   * so that handling was unreachable.
   *
   * Only for reads that answer emptily. It discloses nothing a 404 did not: a
   * caller learns the session is not theirs either way, and gets no data.
   * Anything that acts on a session — prompting, stopping, attaching a project
   * — must keep refusing, because acting on a session that does not exist is a
   * bug rather than an empty answer.
   */
  allowMissing?: boolean;
};

export const requireSessionOwner = async (
  sessionId: string,
  supabase?: SupabaseClient<Database>,
  { allowMissing = false }: SessionOwnerOptions = {},
) => {
  const client = supabase ?? (await createClient());

  // Local access owns everything on this machine. The disk record still decides
  // whether the session exists, so a bad id is a 404 rather than a pass.
  if (!AUTH_REQUIRED) {
    const meta = readSessionMeta(sessionId);
    if (!meta && !hasTranscript(sessionId) && !allowMissing) {
      throw new Response("Session not found.", { status: 404 });
    }
    return { session: { id: sessionId }, user: localUser() };
  }

  const {
    data: { user },
    error: userError,
  } = await client.auth.getUser();

  if (userError || !user) {
    throw new Response("Authentication required.", { status: 401 });
  }

  const { data: session, error: sessionError } = await client
    .from("sessions")
    .select("id")
    .eq("id", sessionId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (sessionError) {
    throw new Error(`Unable to authorize session: ${sessionError.message}`);
  }

  if (!session && !allowMissing) {
    throw new Response("Session not found.", { status: 404 });
  }

  return { session: session ?? { id: sessionId }, user };
};
