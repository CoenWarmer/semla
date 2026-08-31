import { useQuery } from "@tanstack/react-query";

import type { GitStatus } from "@/lib/pi/git-status";

export type SessionGitStatus = GitStatus & { projectPath: string | null };

/**
 * Branch and divergence for the session's project.
 *
 * Polled rather than pushed: the numbers move when the agent commits, when you
 * commit in a terminal, or when the remote moves — none of which the app hears
 * about. Thirty seconds keeps it honest without spawning git subprocesses
 * constantly.
 *
 * A read may start a background fetch, and the counts it returned came from
 * the refs that fetch is replacing. While one is running the poll tightens to
 * three seconds so the corrected numbers land promptly rather than up to half
 * a minute later.
 */
export function useGitStatus(sessionId: string | undefined) {
  return useQuery<SessionGitStatus>({
    queryKey: ["git-status", sessionId],
    enabled: Boolean(sessionId),
    queryFn: async () => {
      const res = await fetch(`/api/sessions/${sessionId}/git`);
      if (!res.ok) throw new Error(`git status ${res.status}`);
      return res.json() as Promise<SessionGitStatus>;
    },
    refetchInterval: (query) => (query.state.data?.fetching ? 3_000 : 30_000),
    staleTime: 0,
  });
}
