import { handleRouteError, requireUser } from "@/lib/api-helpers";
import { hasTranscript, listSessionMeta } from "@/lib/pi/session-meta";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Live state for the sidebar: which sessions exist, which are running, and
 * which have run.
 *
 * It carries enough to render a row because the sidebar is a server component
 * in a layout, and App Router layouts persist across client navigation — so a
 * session created on the way to its own page did not appear until something
 * forced a server re-render, which in practice was the title arriving after the
 * agent's first reply.
 *
 * Replaces a Supabase Realtime subscription on `sessions`. is_running lives on
 * disk now, so the sidebar can follow it without a database — the spinner was
 * the last thing in the app that stopped working when Postgres did.
 *
 * Polled rather than pushed. Realtime is the better mechanism for a shared
 * database, but the state it was carrying is a boolean per session written by
 * this same machine, and a poll of a directory has no connection to lose.
 */
export async function GET() {
  try {
    const { user } = await requireUser();

    const sessions = listSessionMeta()
      .filter((meta) => meta.userId === null || meta.userId === user.id)
      .map((meta) => ({
        id: meta.id,
        title: meta.title,
        createdAt: meta.createdAt,
        isRunning: meta.isRunning,
        // "Ran and finished" rather than "exists": a session that was created
        // and never used has nothing to report as complete.
        hasRun: hasTranscript(meta.id),
      }));

    return Response.json({ sessions });
  } catch (error) {
    return handleRouteError(error, "Unable to load session status.");
  }
}
