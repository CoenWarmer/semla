import { handleRouteError } from "@/lib/api-helpers";
import { readSessionMeta } from "@/lib/pi/session-meta";
import { sessionIsRunning, sessionProjects } from "@/lib/pi/session-status-view";
import { requireSessionOwner } from "@/lib/session-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Live state for one session: whether a turn is in flight, and what it works on.
 *
 * The session page and the header badges used to read this out of the sidebar's
 * whole-list poll, finding their one row and discarding the other hundred and
 * thirty-five. That list is 29 KB and costs a `readFileSync` and a `statSync`
 * per session, and the page asked for it every five seconds whether or not
 * anything was running — in a captured session it was two thirds of all the
 * bytes on the wire.
 *
 * This reads one record. `hasRun`, `title` and `createdAt` are deliberately
 * absent: they belong to a *row in a list*, and no single-session consumer
 * reads them.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    // A session created by its own first prompt is polled before it exists;
    // the missing-record branch below is the answer, and refusing here made it
    // unreachable.
    await requireSessionOwner(id, undefined, { allowMissing: true });

    const meta = readSessionMeta(id);
    // A session with no record on disk is not an error here — it may simply
    // predate the record, or be mid-creation. Nothing running, nothing linked.
    if (!meta) {
      return Response.json({ isRunning: false, projects: [] });
    }

    return Response.json({
      isRunning: sessionIsRunning(meta),
      projects: sessionProjects(meta.projects),
    });
  } catch (error) {
    return handleRouteError(error, `[sessions/${id}/status]`);
  }
}
