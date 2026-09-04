import { handleRouteError, requireUser } from "@/lib/api-helpers";
import { ensurePiAgentDirIsolated } from "@/lib/pi/agent-dir";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export const runtime = "nodejs";

export async function GET() {
  try {
    await requireUser();
    // Defensive: instrumentation.ts's register() normally sets this before any
    // request, but a process where it did not run would otherwise resolve
    // ModelRuntime against the host's ~/.pi/agent instead of Semla's own — see
    // ensurePiAgentDirIsolated()'s docblock.
    ensurePiAgentDirIsolated();
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
