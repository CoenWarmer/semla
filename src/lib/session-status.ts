/**
 * Live session state, shared by everything that asks for it.
 *
 * The sidebar and the session page both want an answer about running sessions,
 * and they used to share one query key with their own fetchers — one returning
 * the array, one the response object — so whichever populated the cache first
 * decided the shape and the other read a field that was not there. One key has
 * to mean one shape, and the only way to guarantee that is one fetcher.
 *
 * There are now two questions, because they have very different costs: "every
 * session" for the sidebar, and "this one session" for the pages looking at
 * one. Each has its own key, shape and fetcher, and the rule above holds within
 * each.
 */

/**
 * One project chip on a session row.
 *
 * A display shape rather than the stored `ProjectLink`: the sidebar needs a
 * name, an order, and something to address the workspace git record with. It
 * carries both paths because the two are keyed differently — the relative one
 * is the link's identity, the absolute one is what `/api/projects/git` keys by,
 * and the client cannot derive one from the other without the workspace root.
 */
export type SessionProject = {
  /** Workspace-relative. The identity. */
  path: string;
  /** Absolute, so a badge can look up its branch. */
  absolutePath: string;
  isPrimary: boolean;
};

export type SessionStatus = {
  id: string;
  title: string | null;
  createdAt: string;
  isRunning: boolean;
  hasRun: boolean;
  /** Anchor first. Empty for a session that relates to no project. */
  projects: SessionProject[];
};

/** The whole list. Only the sidebar needs it. */
export const SESSION_STATUS_KEY = ["session-status"] as const;

export const fetchSessionStatus = async (): Promise<SessionStatus[]> => {
  const response = await fetch("/api/sessions/status");
  if (!response.ok) throw new Error("Unable to load session status.");
  return ((await response.json()) as { sessions: SessionStatus[] }).sessions;
};

/**
 * One session's live state.
 *
 * What a page that is looking at a single session actually needs. The fields a
 * *list row* needs — title, createdAt, hasRun — are absent on purpose: nothing
 * reading one session reads them, and including them would invite this shape to
 * drift back into a copy of the list's.
 */
export type SingleSessionStatus = {
  isRunning: boolean;
  projects: SessionProject[];
};

/**
 * Keyed under the list's prefix, so invalidating SESSION_STATUS_KEY after a
 * create, delete or project change refreshes both without a second call.
 */
export const sessionStatusKey = (sessionId: string) =>
  [...SESSION_STATUS_KEY, sessionId] as const;

export const fetchSingleSessionStatus = async (
  sessionId: string,
): Promise<SingleSessionStatus> => {
  const response = await fetch(`/api/sessions/${sessionId}/status`);
  if (!response.ok) throw new Error("Unable to load session status.");
  return (await response.json()) as SingleSessionStatus;
};
