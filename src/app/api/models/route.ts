import { handleRouteError, requireUser } from "@/lib/api-helpers";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export const runtime = "nodejs";

export async function GET() {
  try {
    await requireUser();
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
    return handleRouteError(error, "Unable to load Pi models.");
  }
}
