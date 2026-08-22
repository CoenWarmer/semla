import { createClient } from "@/app/utils/supabase/server";

export const requireSessionOwner = async (sessionId: string) => {
  const supabase = await createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    throw new Response("Authentication required.", { status: 401 });
  }

  const { data: session, error: sessionError } = await supabase
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
