import { createClient } from "@/app/utils/supabase/server";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export const runtime = "nodejs";

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }

  try {
    const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
    const models = await modelRuntime.getAvailable();

    return Response.json({
      models: models.map((model) => ({
        modelId: model.id,
        name: model.name,
        provider: model.provider,
      })),
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to load Pi models.",
      },
      { status: 500 }
    );
  }
}
