"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

/** A file's cuts as the splits route speaks them: boundaries by `splitKey`. */
type FileSplitRecord = Record<string, number[]>;

const NO_SPLITS: FileSplitRecord = {};

const reviewSplitsQueryKey = (
  sessionId: string,
  project: string,
  path: string,
) => ["review", sessionId, "splits", project, path] as const;

async function fetchSplits(
  sessionId: string,
  project: string,
  path: string,
): Promise<FileSplitRecord> {
  const params = new URLSearchParams({ path, project });
  const res = await fetch(`/api/sessions/${sessionId}/review/splits?${params}`);
  if (!res.ok) throw new Error(`splits ${res.status}`);
  const body = (await res.json()) as { splits: FileSplitRecord };
  return body.splits;
}

/**
 * One file's cuts, read from Semla's state and written back on every change.
 *
 * The query cache *is* the state: `save` writes the new record into it
 * synchronously and then sends it, so a second cut made before the first
 * request returns is computed from the first rather than from what the
 * server last said. Saves share a mutation `scope`, which TanStack runs one
 * at a time in order — without it two in-flight writes could land out of
 * order and the older record would win.
 *
 * Not refetched on focus or on staging: nothing but this hook writes the
 * record, so the cache is never behind the server. The server does prune
 * what it stores (see the splits route), but a pruned key is one the editor
 * can no longer draw anyway.
 */
export function useReviewSplits(sessionId: string, project: string, path: string) {
  const queryClient = useQueryClient();
  const queryKey = reviewSplitsQueryKey(sessionId, project, path);

  const query = useQuery({
    queryFn: () => fetchSplits(sessionId, project, path),
    queryKey,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });

  const mutation = useMutation({
    mutationFn: async (splits: FileSplitRecord) => {
      const res = await fetch(`/api/sessions/${sessionId}/review/splits`, {
        body: JSON.stringify({ path, project, splits }),
        headers: { "Content-Type": "application/json" },
        method: "PUT",
      });
      if (!res.ok) throw new Error(`splits ${res.status}`);
    },
    // A failed save leaves the cache ahead of the server; re-read rather
    // than keep drawing cuts that would not survive the next reload.
    onError: () => queryClient.invalidateQueries({ queryKey }),
    scope: { id: `review-splits:${sessionId}:${project}:${path}` },
  });

  const save = (update: (current: FileSplitRecord) => FileSplitRecord) => {
    const next = update(queryClient.getQueryData<FileSplitRecord>(queryKey) ?? NO_SPLITS);
    void queryClient.cancelQueries({ queryKey });
    queryClient.setQueryData(queryKey, next);
    mutation.mutate(next);
  };

  return { save, splits: query.data ?? NO_SPLITS };
}
