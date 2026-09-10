"use client";

import { useQuery } from "@tanstack/react-query";

import type { FileAccessTimeline } from "@/lib/pi/file-access/access-types";

/**
 * What the agents read and wrote, for the scrubber.
 *
 * Not polled. The timeline is derived from the session file, which only grows
 * while a turn runs — and while one runs the live `file-access` events are the
 * cheaper source, so a timer would re-read and re-stat the whole transcript to
 * learn what the stream already said. It is refetched when a turn ends, by the
 * same invalidation that refreshes the review.
 */

export const fileAccessQueryKey = (sessionId: string, leafId: string | null) =>
  ["file-access", sessionId, leafId] as const;

export function useFileAccess(
  sessionId: string,
  leafId: string | null = null,
  enabled = true,
) {
  return useQuery({
    enabled,
    queryFn: async (): Promise<FileAccessTimeline> => {
      const query = leafId ? `?leaf=${encodeURIComponent(leafId)}` : "";
      const res = await fetch(`/api/sessions/${sessionId}/file-access${query}`);
      if (!res.ok) throw new Error(`file access ${res.status}`);
      return res.json();
    },
    queryKey: fileAccessQueryKey(sessionId, leafId),
    staleTime: 0,
  });
}
