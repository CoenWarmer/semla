import { useQuery } from "@tanstack/react-query";

import type { GitStatus } from "@/lib/pi/git-status";

/**
 * What a branch indicator is reporting on.
 *
 * The split is about *fetching*, not about counting repositories. A session's
 * projects are read one at a time and may fetch, because that is the indicator
 * somebody is looking at and stale refs lie. Cards are one of dozens, so the
 * whole workspace is read in a single request and none of it fetches until you
 * open a card's popover.
 *
 * `path` narrows a session read to one of its projects. Omit it and the read
 * yields the session's anchor. Either way the query key is the session, so
 * every badge in a header shares one request however many there are.
 */
export type GitTarget =
  | { kind: "session"; sessionId: string; path?: string }
  | { kind: "project"; path: string };

export const gitStatusQueryKey = (target: GitTarget | undefined) =>
  target?.kind === "session"
    ? ["git-status", "session", target.sessionId]
    : ["git-status", "workspace"];

/** Keyed by workspace-relative project path, anchor first. */
async function fetchSessionStatus(
  sessionId: string,
): Promise<Record<string, GitStatus>> {
  const res = await fetch(`/api/sessions/${sessionId}/git`);
  if (!res.ok) throw new Error(`git status ${res.status}`);
  return (await res.json()) as Record<string, GitStatus>;
}

async function fetchWorkspaceStatus(): Promise<Record<string, GitStatus>> {
  const res = await fetch("/api/projects/git");
  if (!res.ok) throw new Error(`git status ${res.status}`);
  return (await res.json()) as Record<string, GitStatus>;
}

/** Both reads now yield one status per path; only the keying differs. */
type GitStatusPayload = Record<string, GitStatus>;

/**
 * The status a target names within a payload.
 *
 * With a path, both kinds are a plain lookup. Without one — a session badge
 * that has not been told which project it is for — the anchor is taken, which
 * the session route emits first.
 */
const statusFor = (
  payload: Record<string, GitStatus> | undefined,
  target: GitTarget | undefined,
): GitStatus | undefined => {
  if (!payload || !target) return undefined;
  if (target.path) return payload[target.path];
  return Object.values(payload)[0];
};

/**
 * Branch and divergence for a session's project or a workspace project.
 *
 * Polled rather than pushed: the numbers move when the agent commits, when you
 * commit in a terminal, or when the remote moves — none of which the app hears
 * about. Thirty seconds keeps it honest without spawning git subprocesses
 * constantly.
 *
 * A session read may start a background fetch, and the counts it returned came
 * from the refs that fetch is replacing. While one is running the poll tightens
 * to three seconds so the corrected numbers land promptly.
 *
 * Every card shares one workspace query, so a page of forty projects makes one
 * request rather than forty.
 */
export function useGitStatus(target: GitTarget | undefined) {
  const query = useQuery<GitStatusPayload>({
    queryKey: gitStatusQueryKey(target),
    enabled: Boolean(target),
    queryFn: () =>
      target?.kind === "session"
        ? fetchSessionStatus(target.sessionId)
        : fetchWorkspaceStatus(),
    refetchInterval: (q) =>
      statusFor(q.state.data, target)?.fetching ? 3_000 : 30_000,
    staleTime: 0,
  });

  return { ...query, data: statusFor(query.data, target) };
}
