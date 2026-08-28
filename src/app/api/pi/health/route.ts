import { handleRouteError, requireUser } from "@/lib/api-helpers";
import { getExtensionHealth } from "@/lib/pi/extension-health";

export const runtime = "nodejs";

// Never cached: the whole point is to reflect the extension set as it is right
// now, including a package that was uninstalled since the server started.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireUser();

    const health = getExtensionHealth();

    return Response.json(health, { status: health.ok ? 200 : 503 });
  } catch (error) {
    return handleRouteError(error, "Unable to read Pi extension health.");
  }
}
