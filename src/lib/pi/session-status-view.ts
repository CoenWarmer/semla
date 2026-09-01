/**
 * The status shape both status routes answer with.
 *
 * The list route serves the sidebar, which needs a row per session; the
 * per-session route serves the pages that care about exactly one. They agree on
 * what a session's live state looks like by sharing this mapping rather than
 * writing it twice — the failure that shape drift causes here is a field that
 * is present on one endpoint and quietly missing on the other.
 */

import { hasTranscript, type SessionMeta } from "@/lib/pi/session-meta";
import { orderLinks, type ProjectLink } from "@/lib/pi/session-project-links";
import { isSessionActive } from "@/lib/pi/session-service";

/**
 * Is a turn actually in flight for this session?
 *
 * A record can claim to be running after the process running it has gone: the
 * turn clears the flag in a `finally`, which a killed server never reaches,
 * leaving a spinner with nothing behind it. The loop only ever existed in
 * memory, so this process not working on the session settles it.
 */
export const sessionIsRunning = (meta: SessionMeta): boolean =>
  meta.isRunning && isSessionActive(meta.id);

/**
 * Anchor first, workspace-relative path only.
 *
 * `isPrimary` is not sent: nothing reads it from this payload — the projects
 * panel gets its links from /api/sessions/[id]/projects — and `orderLinks`
 * already puts the anchor first, so the ordering carries what the flag said.
 *
 * `absolutePath` is not sent either. It was `PI_WORKSPACE_ROOT + "/" + path`
 * repeated on every project of every row; the root goes out once per response
 * instead and the one consumer that needs an absolute path joins it.
 */
export const sessionProjects = (links: readonly ProjectLink[]) =>
  orderLinks(links).map((link) => ({ path: link.path }));

/** One session's row for the sidebar's list. */
export const toSessionStatus = (meta: SessionMeta) => ({
  id: meta.id,
  title: meta.title,
  createdAt: meta.createdAt,
  isRunning: sessionIsRunning(meta),
  // "Ran and finished" rather than "exists": a session that was created and
  // never used has nothing to report as complete.
  hasRun: hasTranscript(meta.id),
  projects: sessionProjects(meta.projects),
});
