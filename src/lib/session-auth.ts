import { AUTH_REQUIRED, localUser } from "@/lib/auth-mode";
import { hasTranscript, readSessionMeta } from "@/lib/pi/session-meta";
import { createClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.types";

export const requireSessionOwner = async (
  sessionId: string,
  supabase?: SupabaseClient<Database>,
) => {
  const client = supabase ?? (await createClient());

  // Local access owns everything on this machine. The disk record still decides
  // whether the session exists, so a bad id is a 404 rather than a pass.
  if (!AUTH_REQUIRED) {
    const meta = readSessionMeta(sessionId);
    if (!meta && !hasTranscript(sessionId)) {
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

  if (!session) {
    throw new Response("Session not found.", { status: 404 });
  }

  return { session, user };
};
