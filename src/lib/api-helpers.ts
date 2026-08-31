import type { User } from "@supabase/supabase-js";

import { AUTH_REQUIRED, localUser } from "@/lib/auth-mode";
import { createClient } from "@/lib/supabase/server";

export const requireUser = async () => {
  const supabase = await createClient();

  // Bound to loopback there is nobody to authenticate, and asking Supabase who
  // it is fails the request for reasons unrelated to what it wants to do.
  if (!AUTH_REQUIRED) {
    return { supabase, user: localUser() as unknown as User };
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    throw new Response("Authentication required.", { status: 401 });
  }

  return { supabase, user };
};

export const handleRouteError = (
  error: unknown,
  fallbackMessage = "An unexpected error occurred.",
): Response => {
  if (error instanceof Response) {
    return error;
  }

  console.error("[api:error]", error);

  return Response.json(
    {
      error: error instanceof Error ? error.message : fallbackMessage,
    },
    { status: 500 },
  );
};
