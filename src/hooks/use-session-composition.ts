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
 * Refreshed by invalidation when a turn lands, not by a counter in the key.
 *
 * The key used to carry `messages.length + toolCalls.length`, which made every
 * change to either a brand-new cache entry and therefore a fetch. That counted
 * the optimistic prompt — refetching immediately on submit, for data the server
 * cannot have yet, since a turn's entries are only persisted when it ends — and
 * it counted *live* tool calls, so a tool-heavy turn re-parsed the whole
 * transcript once per tool call. `placeholderData` kept it all off screen.
 */
export function useSessionComposition(sessionId: string) {
  return useQuery<CompositionBreakdown>({
    queryKey: compositionQueryKey(sessionId),
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
