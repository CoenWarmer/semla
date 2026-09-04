import { useQuery } from "@tanstack/react-query";

import type { TurnGraph } from "@/lib/pi/session-turn-graph";

export const turnGraphQueryKey = (sessionId: string) =>
  ["turn-graph", sessionId] as const;

const fetchTurnGraph = async (sessionId: string): Promise<TurnGraph> => {
  const response = await fetch(`/api/sessions/${sessionId}/turn-graph`);
  if (!response.ok) {
    throw new Error("Unable to load this session's branches.");
  }
  return response.json() as Promise<TurnGraph>;
};

/**
 * A session's branch structure. Polled only while its panel is open — this
 * is read-only structure a click elsewhere in the app has no reason to keep
 * fresh, unlike the transcript itself.
 */
export const useTurnGraph = (sessionId: string, enabled: boolean) =>
  useQuery({
    enabled,
    queryFn: () => fetchTurnGraph(sessionId),
    queryKey: turnGraphQueryKey(sessionId),
    refetchInterval: enabled ? 10_000 : false,
  });
