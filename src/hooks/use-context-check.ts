import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ContextCheckResult } from "@/app/api/sessions/[id]/context-check/route";

export type { ContextCheckResult };

export const contextCheckQueryKey = (sessionId: string) =>
  ["context-check", sessionId] as const;

export function useContextCheckResult(sessionId: string) {
  return useQuery<ContextCheckResult>({
    queryKey: contextCheckQueryKey(sessionId),
    queryFn: () => {
      throw new Error("Use triggerContextCheck to populate this cache entry.");
    },
    enabled: false,
    staleTime: Infinity,
  });
}

export function useTriggerContextCheck(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const response = await fetch(`/api/sessions/${sessionId}/context-check`, {
        method: "POST",
      });
      if (!response.ok) throw new Error("Context check failed.");
      return response.json() as Promise<ContextCheckResult>;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(contextCheckQueryKey(sessionId), data);
    },
  });
}
