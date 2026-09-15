import { handleRouteError, requireUser } from "@/lib/api-helpers";
import {
  EXTENSION_TOOLS,
  extensionToolsForSession,
} from "@/lib/pi/extension-manifest";
import { PI_TOOLS } from "@/lib/pi/runtime-config";
import { isProjectAnchored, resolveSessionCwd } from "@/lib/pi/session/session-cwd";
import { sessionProjects } from "@/lib/pi/session/session-project";
import { requireSessionOwner } from "@/lib/session-auth";

export const runtime = "nodejs";

/**
 * `placement-tools` (architecture-awareness item 3) deliberately backs the
 * built-in `edit`/`write` tool names under an extension — see the named
 * exception in `assertManifestIsCoherent`. Those two names are already in
 * `PI_TOOLS`/`toggleableTools`; without this, the prompt-bar tool picker and
 * its count would list `edit`/`write` twice, once as a toggleable built-in
 * and once as an "extension tool" nobody can distinguish from the first.
 */
function dedupeAgainstToggleable(extensionTools: string[]): string[] {
  return extensionTools.filter((tool) => !(PI_TOOLS as readonly string[]).includes(tool));
}

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
        extensionTools: dedupeAgainstToggleable([...EXTENSION_TOOLS]),
        toggleableTools: [...PI_TOOLS],
      });
    }

    // Owning the session is the stronger check, and it is the one that decides
    // whether these projects may be read at all. A session created by its own
    // first prompt is asked about before it exists, and the honest answer then
    // is the tools that are certainly present: it has no project, so it gets
    // the unanchored set. Refusing instead left the prompt bar reporting no
    // extension tools at all, and the query is invalidated once the session
    // gains a project.
    await requireSessionOwner(sessionId, undefined, { allowMissing: true });
    const links = await sessionProjects(sessionId);
    const projectAnchored = isProjectAnchored(
      resolveSessionCwd(links.map((link) => link.path)),
    );

    return Response.json({
      extensionTools: dedupeAgainstToggleable([...extensionToolsForSession({ projectAnchored })]),
      toggleableTools: [...PI_TOOLS],
    });
  } catch (error) {
    return handleRouteError(error, "Unable to load Pi tools.");
  }
}
