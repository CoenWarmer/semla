import { handleRouteError, requireUser } from "@/lib/api-helpers";
import { EXTENSION_TOOLS, PI_TOOLS } from "@/lib/pi/runtime-config";

export const runtime = "nodejs";

export async function GET() {
  try {
    await requireUser();

    return Response.json({
      extensionTools: [...EXTENSION_TOOLS],
      toggleableTools: [...PI_TOOLS],
    });
  } catch (error) {
    return handleRouteError(error, "Unable to load Pi tools.");
  }
}
