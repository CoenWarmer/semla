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
 * name and an order. The absolute path `/api/projects/git` keys by is derived
 * with `projectAbsolutePath` from the workspace root, which the server hands
 * the sidebar directly.
 */
export type SessionProject = {
  /** Workspace-relative. The identity, and all that is sent. */
  path: string;
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
 * Absolute path for a project chip, for the git record keyed by one.
 *
 * The workspace root reaches the sidebar as a prop from the server component
 * that renders it, not as a field on every project of every row — it is one
 * value for the whole machine, and repeating it 47 times per poll was 7% of the
 * payload.
 */
export const projectAbsolutePath = (workspaceRoot: string, path: string) =>
  `${workspaceRoot}/${path}`;

/**
 * The list with one session's running flag corrected.
 *
 * The sidebar's spinner comes from the list poll, whose interval only
 * accelerates to 2s *after* a poll happens to catch something running — so at
 * the idle 15s a short turn can begin and end between two polls and never show
 * one. The page starting the turn knows before any poll does, so it says so
 * directly instead of buying the answer with a request.
 *
 * Returns undefined untouched: a session the sidebar has not listed yet has no
 * row to correct, and the poll will discover it.
 */
export const withSessionRunning = (
  sessions: SessionStatus[] | undefined,
  sessionId: string,
  isRunning: boolean,
): SessionStatus[] | undefined =>
  sessions?.map((session) =>
    session.id === sessionId ? { ...session, isRunning } : session,
  );

/**
 * One session's live state.
 *
 * What a page that is looking at a single session actually needs. The fields a
 * *list row* needs — title, createdAt, hasRun — are absent on purpose: nothing
 * reading one session reads them, and including them would invite this shape to
 * drift back into a copy of the list's.
 */
export type SingleSessionStatus = {
  /**
   * Whether the session has a record on disk.
   *
   * Read as `=== false` by callers, never as `!exists`: undefined means a
   * server that did not report it, which is not the same claim.
   */
  exists?: boolean;
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
