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
