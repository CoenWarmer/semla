import { useQuery } from "@tanstack/react-query";

import type { GitStatus } from "@/lib/pi/git-status";

export type SessionGitStatus = GitStatus & { projectPath: string | null };

/**
 * Branch and divergence for the session's project.
 *
 * Polled rather than pushed: the numbers move when the agent commits, when you
 * commit in a terminal, or when you fetch — none of which the app hears about.
 * Thirty seconds keeps it honest without spawning git subprocesses constantly.
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
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}
