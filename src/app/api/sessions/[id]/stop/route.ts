import { handleRouteError } from "@/lib/api-helpers";
import { stopPiSession } from "@/lib/pi/session-service";
import { requireSessionOwner } from "@/lib/session-auth";

export const runtime = "nodejs";

/**
 * Interrupt a session's current turn.
 *
 * The agent loop runs inside this process and nothing outside it could reach
 * the loop, so a run that had gone wrong could only be waited out or killed
 * with the server — and an orient turn runs for tens of minutes.
 *
 * `stopped: false` means there was nothing running: the turn had already
 * finished, or it belongs to a process that is no longer here. Both are a
 * success as far as the caller is concerned — the session is not running.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    await requireSessionOwner(id);
  } catch (error) {
    return handleRouteError(error, "Unable to authorize session.");
  }

  try {
    return Response.json({ stopped: await stopPiSession(id) });
  } catch (error) {
    return handleRouteError(error, "Unable to stop the session.");
  }
}
