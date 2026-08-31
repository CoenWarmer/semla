import { useQuery } from "@tanstack/react-query";

import type { CompositionBreakdown } from "@/lib/pi/context-composition";

export type { CompositionBreakdown };

export const compositionQueryKey = (sessionId: string) =>
  ["session-composition", sessionId] as const;

/**
 * What the session's context window is made of.
 *
 * Runs from the first render rather than waiting for a context inspection.
 * The two used to be the same request, so the composition bar — which is only
 * arithmetic over message lengths — stayed hidden until somebody opened the
 * inspector and paid for a model call.
 *
 * `turnKey` changes as the conversation grows, which refetches without needing
 * a tight poll: the numbers only move when a message or tool result lands.
 */
export function useSessionComposition(sessionId: string, turnKey: number) {
  return useQuery<CompositionBreakdown>({
    queryKey: [...compositionQueryKey(sessionId), turnKey],
    queryFn: async () => {
      const res = await fetch(`/api/sessions/${sessionId}/composition`);
      if (!res.ok) throw new Error(`composition ${res.status}`);
      return (await res.json()) as CompositionBreakdown;
    },
    // Keep the previous shape on screen while the next turn's is fetched, so
    // the bar does not blink out between turns.
    placeholderData: (previous) => previous,
    staleTime: 10_000,
  });
}
