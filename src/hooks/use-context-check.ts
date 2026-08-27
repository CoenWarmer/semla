import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ContextCheckResult, StoredInspection } from "@/app/api/sessions/[id]/context-check/route";

export type { ContextCheckResult, StoredInspection };

export const inspectionsQueryKey = (sessionId: string) =>
  ["context-inspections", sessionId] as const;

export function useContextInspections(sessionId: string) {
  return useQuery<StoredInspection[]>({
    queryKey: inspectionsQueryKey(sessionId),
    queryFn: async () => {
      const response = await fetch(`/api/sessions/${sessionId}/context-check`);
      if (!response.ok) throw new Error("Failed to load inspections.");
      const data = (await response.json()) as { inspections: StoredInspection[] };
      return data.inspections;
    },
    staleTime: 30_000,
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
    onSuccess: (result) => {
      // Prepend the new result to the cached inspections list immediately,
      // without waiting for a refetch.
      queryClient.setQueryData(
        inspectionsQueryKey(sessionId),
        (prev: StoredInspection[] | undefined) => {
          const next: StoredInspection = {
            createdAt: result.checkedAt,
            id: crypto.randomUUID(),
            result,
          };
          return [next, ...(prev ?? [])];
        },
      );
    },
  });
}
