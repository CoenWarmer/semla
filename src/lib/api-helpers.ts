import { createClient } from "@/lib/supabase/server";

export const requireUser = async () => {
  const supabase = await createClient();
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
): Response =>
  error instanceof Response
    ? error
    : Response.json(
        {
          error:
            error instanceof Error ? error.message : fallbackMessage,
        },
        { status: 500 },
      );
