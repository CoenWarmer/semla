/**
 * Live session state, shared by everything that asks for it.
 *
 * The sidebar and the session page both want the same answer — which sessions
 * exist, which are running — and both cache it under the same query key. They
 * had their own fetchers, one returning the array and one the response object,
 * so whichever populated the cache first decided the shape and the other read
 * a field that was not there. One key has to mean one shape, and the only way
 * to guarantee that is one fetcher.
 */

export type SessionStatus = {
  id: string;
  title: string | null;
  createdAt: string;
  isRunning: boolean;
  hasRun: boolean;
};

export const SESSION_STATUS_KEY = ["session-status"] as const;

export const fetchSessionStatus = async (): Promise<SessionStatus[]> => {
  const response = await fetch("/api/sessions/status");
  if (!response.ok) throw new Error("Unable to load session status.");
  return ((await response.json()) as { sessions: SessionStatus[] }).sessions;
};
