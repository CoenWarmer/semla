import { useQuery } from "@tanstack/react-query";

import type { GitStatus } from "@/lib/pi/git-status";

/**
 * What a branch indicator is reporting on.
 *
 * A session knows its project and is the only repository on screen, so it is
 * read one at a time and may fetch. A card is one of dozens, so the whole
 * workspace is read in a single request and none of it fetches until you open
 * a card's popover.
 */
export type GitTarget =
  | { kind: "session"; sessionId: string }
  | { kind: "project"; path: string };

export type SessionGitStatus = GitStatus & { projectPath: string | null };

export const gitStatusQueryKey = (target: GitTarget | undefined) =>
  target?.kind === "session"
    ? ["git-status", "session", target.sessionId]
    : ["git-status", "workspace"];

async function fetchSessionStatus(sessionId: string): Promise<GitStatus> {
  const res = await fetch(`/api/sessions/${sessionId}/git`);
  if (!res.ok) throw new Error(`git status ${res.status}`);
  return (await res.json()) as SessionGitStatus;
}

async function fetchWorkspaceStatus(): Promise<Record<string, GitStatus>> {
  const res = await fetch("/api/projects/git");
  if (!res.ok) throw new Error(`git status ${res.status}`);
  return (await res.json()) as Record<string, GitStatus>;
}

/** A session read yields one status; a workspace read yields one per path. */
type GitStatusPayload = GitStatus | Record<string, GitStatus>;

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
    refetchInterval: (q) => {
      const data = q.state.data;
      const status =
        target?.kind === "project"
          ? (data as Record<string, GitStatus>)?.[target.path]
          : (data as GitStatus | undefined);
      return status?.fetching ? 3_000 : 30_000;
    },
    staleTime: 0,
  });

  const data =
    target?.kind === "project"
      ? (query.data as Record<string, GitStatus> | undefined)?.[target.path]
      : (query.data as GitStatus | undefined);

  return { ...query, data };
}
