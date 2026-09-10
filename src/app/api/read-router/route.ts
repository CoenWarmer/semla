import { handleRouteError, requireUser } from "@/lib/api-helpers";
import {
  loadWorkflowSettings,
  saveWorkflowSettingsForCwd,
} from "@/lib/pi/extensions/dynamic-workflows/src/workflow-settings";

export const runtime = "nodejs";

/** The effective read-router setting for sessions anchored to this project. */
export async function GET() {
  try {
    await requireUser();
    const settings = loadWorkflowSettings({ cwd: process.cwd() });
    return Response.json({ enabled: settings.readRouterEnabled ?? true });
  } catch (error) {
    return handleRouteError(error, "Unable to load the read-router setting.");
  }
}

/** Toggle tool-result compression globally and for this project. */
export async function PUT(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    enabled?: unknown;
  } | null;

  if (typeof body?.enabled !== "boolean") {
    return Response.json(
      { error: "Request body must contain a boolean enabled value." },
      { status: 400 },
    );
  }

  try {
    await requireUser();
    saveWorkflowSettingsForCwd(
      { readRouterEnabled: body.enabled },
      process.cwd(),
    );
    return Response.json({ enabled: body.enabled });
  } catch (error) {
    return handleRouteError(error, "Unable to save the read-router setting.");
  }
}
