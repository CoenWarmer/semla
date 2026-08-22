import { createClient } from "@/app/utils/supabase/server";

export const runtime = "nodejs";

const requireUser = async () => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    throw new Response("Authentication required.", { status: 401 });
  }

  return { supabase, user };
};

export async function GET() {
  try {
    const { supabase, user } = await requireUser();
    const { data, error } = await supabase
      .from("user_settings")
      .select("default_model_id, default_model_provider")
      .eq("user_id", user.id)
      .maybeSingle();

    if (error) {
      throw error;
    }

    return Response.json({ settings: data });
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }

    return Response.json(
      { error: "Unable to load user settings." },
      { status: 500 }
    );
  }
}

export async function PUT(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    defaultModelId?: unknown;
    defaultModelProvider?: unknown;
  } | null;
  const defaultModelId =
    typeof body?.defaultModelId === "string" ? body.defaultModelId : "";
  const defaultModelProvider =
    typeof body?.defaultModelProvider === "string"
      ? body.defaultModelProvider
      : "";

  if (!defaultModelId || !defaultModelProvider) {
    return Response.json({ error: "A model is required." }, { status: 400 });
  }

  try {
    const { supabase, user } = await requireUser();
    const { data, error } = await supabase
      .from("user_settings")
      .upsert(
        {
          default_model_id: defaultModelId,
          default_model_provider: defaultModelProvider,
          updated_at: new Date().toISOString(),
          user_id: user.id,
        },
        { onConflict: "user_id" }
      )
      .select("default_model_id, default_model_provider")
      .single();

    if (error) {
      throw error;
    }

    return Response.json({ settings: data });
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }

    return Response.json(
      { error: "Unable to save the default model." },
      { status: 500 }
    );
  }
}
