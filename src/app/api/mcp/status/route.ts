import { handleRouteError, requireUser } from "@/lib/api-helpers";
import { getMcpConfigSummary } from "@/lib/pi/mcp-config";

export const runtime = "nodejs";

// Never cached: reflects the pinned mcp.json as it is right now, and an
// operator can edit that file while Semla is running.
export const dynamic = "force-dynamic";

/**
 * The configured MCP servers, for the prompt bar.
 *
 * A static read of the pinned exclusive-mode config file — see
 * getMcpConfigSummary()'s docblock for why connection status (connected /
 * needs-auth / failed) is not answerable here: that only exists inside a
 * running session, which a route handler is not. This is deliberately the
 * narrower, cheaper question: what did the operator configure, at all.
 *
 * Not session-scoped, unlike /api/tools: the pinned mcp.json is one file for
 * the whole server, not something that varies with which project a session is
 * anchored on.
 */
export async function GET() {
  try {
    await requireUser();

    const summary = await getMcpConfigSummary();

    return Response.json(summary);
  } catch (error) {
    return handleRouteError(error, "Unable to read MCP server configuration.");
  }
}
