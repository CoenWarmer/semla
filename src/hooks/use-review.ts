"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { FileDiff } from "@/lib/review-types";
import type { ChangedFile, SessionReview } from "@/lib/review-types";

/**
 * What there is to review, and one file's hunks.
 *
 * Not polled. The review state changes when a turn ends, when the operator
 * saves a file, or when they commit — all of which this client does or is
 * told about, so a timer would only add git subprocesses. `useGitStatus` polls
 * because *its* numbers also move when a remote does; these do not.
 */

export const reviewQueryKey = (sessionId: string) =>
  ["review", sessionId] as const;

export const reviewHunksQueryKey = (
  sessionId: string,
  project: string | null,
  path: string | null,
) => ["review", sessionId, "hunks", project, path] as const;

async function fetchReview(sessionId: string): Promise<SessionReview> {
  const res = await fetch(`/api/sessions/${sessionId}/review`);
  if (!res.ok) throw new Error(`review ${res.status}`);
  return res.json();
}

export function useReview(sessionId: string, enabled = true) {
  return useQuery({
    enabled,
    queryFn: () => fetchReview(sessionId),
    queryKey: reviewQueryKey(sessionId),
    staleTime: 0,
  });
}

export interface FileHunks {
  full: FileDiff | null;
  staged: FileDiff | null;
  unstaged: FileDiff | null;
  untracked: boolean;
  file: ChangedFile;
  project: string;
}

async function fetchHunks(
  sessionId: string,
  project: string,
  path: string,
): Promise<FileHunks> {
  const params = new URLSearchParams({ path, project });
  const res = await fetch(`/api/sessions/${sessionId}/review/hunks?${params}`);
  if (!res.ok) throw new Error(`hunks ${res.status}`);
  return res.json();
}

export function useReviewHunks(
  sessionId: string,
  project: string | null,
  path: string | null,
) {
  return useQuery({
    enabled: Boolean(project && path),
    queryFn: () => fetchHunks(sessionId, project!, path!),
    queryKey: reviewHunksQueryKey(sessionId, project, path),
    staleTime: 0,
  });
}

/**
 * A file's content, by workspace-relative path.
 *
 * The review panel speaks project-relative paths while the file API speaks
 * workspace-relative ones, and a project link is itself a workspace-relative
 * path — so the two compose by joining, and the existing route is reused
 * rather than duplicated.
 */
export const workspacePath = (project: string, path: string) =>
  `${project}/${path}`;

export const fileContentQueryKey = (sessionId: string, path: string | null) =>
  ["session-file-content", sessionId, path] as const;

export function useFileContent(sessionId: string, path: string | null) {
  return useQuery({
    enabled: path !== null,
    queryFn: async () => {
      const params = new URLSearchParams({ path: path! });
      const res = await fetch(
        `/api/sessions/${sessionId}/files/content?${params}`,
      );
      if (!res.ok) throw new Error("Unable to read file");
      return res.json() as Promise<{ content: string; path: string }>;
    },
    queryKey: fileContentQueryKey(sessionId, path),
    staleTime: 0,
  });
}

/**
 * Record that the operator has seen this state.
 *
 * The fingerprint that was displayed is sent back rather than recomputed on
 * the server: dismissing means "I have seen what I was shown", and re-reading
 * git would file a verdict against a state that may already have moved.
 */
export function useDismissReview(sessionId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (fingerprint: string) => {
      const res = await fetch(`/api/sessions/${sessionId}/review`, {
        body: JSON.stringify({ fingerprint }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!res.ok) throw new Error("Unable to record the review");
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: reviewQueryKey(sessionId) });
    },
  });
}
