import { join } from "node:path";

import { handleRouteError, requireUser } from "@/lib/api-helpers";
import { PI_WORKSPACE_ROOT } from "@/lib/pi/runtime-config";
import { hasTranscript, listSessionMeta } from "@/lib/pi/session-meta";
import { impliedLinks } from "@/lib/pi/session-project";
import { orderLinks } from "@/lib/pi/session-project-links";
import { isSessionActive } from "@/lib/pi/session-service";

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
        // A record can claim to be running after the process that was running
        // it has gone: the turn clears the flag in a `finally`, which a killed
        // server never reaches, leaving a spinner with nothing behind it.
        // The loop only ever existed in memory, so this process not working on
        // the session settles it.
        isRunning: meta.isRunning && isSessionActive(meta.id),
        // "Ran and finished" rather than "exists": a session that was created
        // and never used has nothing to report as complete.
        hasRun: hasTranscript(meta.id),
        // Records written before the relation existed carry only projectPath,
        // and there are far more of those than of real links — synthesising
        // here is what stops almost every existing session rendering as though
        // it relates to nothing. Pure and file-free, so the route keeps costing
        // one directory read.
        projects: (meta.projects.length > 0
          ? orderLinks(meta.projects)
          : impliedLinks(PI_WORKSPACE_ROOT, meta.projectPath, meta.createdAt)
        ).map((link) => ({
          absolutePath: join(PI_WORKSPACE_ROOT, link.path),
          isPrimary: link.isPrimary,
          path: link.path,
        })),
      }));

    return Response.json({ sessions });
  } catch (error) {
    return handleRouteError(error, "Unable to load session status.");
  }
}
