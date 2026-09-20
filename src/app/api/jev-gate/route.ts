import { handleRouteError, requireUser } from "@/lib/api/api-helpers";
import {
  loadWorkflowSettings,
  saveWorkflowSettingsForCwd,
} from "@/lib/pi/extensions/dynamic-workflows/src/workflow-settings";

export const runtime = "nodejs";

/** The effective jev-gate setting for sessions anchored to this project. */
export async function GET() {
  try {
    await requireUser();
    const settings = loadWorkflowSettings({ cwd: process.cwd() });
    return Response.json({ enabled: settings.jevGateEnabled === true });
  } catch (error) {
    return handleRouteError(error, "Unable to load the jev-gate setting.");
  }
}

/** Toggle tool/skill gating via the Jev Decisions API globally and for this project. */
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
      { jevGateEnabled: body.enabled },
      process.cwd(),
    );
    return Response.json({ enabled: body.enabled });
  } catch (error) {
    return handleRouteError(error, "Unable to save the jev-gate setting.");
  }
}
