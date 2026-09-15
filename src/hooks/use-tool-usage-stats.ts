import { useQuery } from "@tanstack/react-query";

import type { ToolUsageBucket } from "@/lib/pi/tool-usage-stats";

export type ToolUsageStats = { buckets: ToolUsageBucket[] };

const fetchToolUsageStats = async (
  from: Date,
  to: Date,
  sessionId: string | null,
): Promise<ToolUsageStats> => {
  const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
  if (sessionId) params.set("sessionId", sessionId);
  const response = await fetch(`/api/stats/tool-usage?${params.toString()}`);
  if (!response.ok) throw new Error("Unable to load tool usage stats.");
  return response.json() as Promise<ToolUsageStats>;
};

/**
 * `sessionId: null` means "all sessions" — the panel's default scope, and the
 * only option outside a session page.
 */
export function useToolUsageStats(from: Date, to: Date, sessionId: string | null = null) {
  return useQuery({
    queryFn: () => fetchToolUsageStats(from, to, sessionId),
    queryKey: ["tool-usage-stats", from.toISOString(), to.toISOString(), sessionId],
    staleTime: 30_000,
  });
}
