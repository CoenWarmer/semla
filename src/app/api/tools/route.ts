import { handleRouteError, requireUser } from "@/lib/api-helpers";
import {
  EXTENSION_TOOLS,
  extensionToolsForSession,
} from "@/lib/pi/extension-manifest";
import { PI_TOOLS } from "@/lib/pi/runtime-config";
import { isProjectAnchored, resolveSessionCwd } from "@/lib/pi/session-cwd";
import { sessionProjects } from "@/lib/pi/session-project";
import { requireSessionOwner } from "@/lib/session-auth";

export const runtime = "nodejs";

/**
 * The tools a session actually has.
 *
 * `sessionId` is optional because /sessions/new has no session yet, and there
 * the full set is the honest answer: whichever project the first prompt lands
 * in, the session will be anchored by the time it runs. With an id, the answer
 * narrows to what that session's extension set will contribute — a session with
 * no project does not load the project-scoped extensions, and advertising their
 * tools would offer the agent capabilities it does not have.
 */
export async function GET(request: Request) {
  try {
    const sessionId = new URL(request.url).searchParams.get("sessionId");

    if (!sessionId) {
      await requireUser();
      return Response.json({
        extensionTools: [...EXTENSION_TOOLS],
        toggleableTools: [...PI_TOOLS],
      });
    }

    // Owning the session is the stronger check, and it is the one that decides
    // whether these projects may be read at all.
    await requireSessionOwner(sessionId);
    const links = await sessionProjects(sessionId);
    const projectAnchored = isProjectAnchored(
      resolveSessionCwd(links.map((link) => link.path)),
    );

    return Response.json({
      extensionTools: [...extensionToolsForSession({ projectAnchored })],
      toggleableTools: [...PI_TOOLS],
    });
  } catch (error) {
    return handleRouteError(error, "Unable to load Pi tools.");
  }
}
