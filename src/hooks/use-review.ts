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

/**
 * One file's hunks, or null when git says it has none.
 *
 * A 404 is an answer rather than an error: the tree underneath the changed
 * bucket lets the operator open any file in the project, and most of them the
 * turn never touched. Those open in the editor with nothing coloured and
 * nothing to stage, which is exactly right — the file that was *not* changed
 * but should have been is a review finding too.
 */
async function fetchHunks(
  sessionId: string,
  project: string,
  path: string,
): Promise<FileHunks | null> {
  const params = new URLSearchParams({ path, project });
  const res = await fetch(`/api/sessions/${sessionId}/review/hunks?${params}`);
  if (res.status === 404) return null;
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
      // `sha` is what a later save sends back so the server can refuse to
      // overwrite a file that moved underneath.
      return res.json() as Promise<{
        content: string;
        path: string;
        sha: string;
      }>;
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

/** What every write here answers with, so failures can be shown in place. */
export interface ReviewActionResult {
  ok: boolean;
  message: string;
  sha?: string;
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  return res.json() as Promise<T>;
}

/**
 * Everything that has to re-read after the index or HEAD moves.
 *
 * One list rather than three call sites that drift: staging changes which
 * hunks are on which side, committing changes both that and the branch state
 * the header badges show.
 */
function invalidateAfterWrite(
  queryClient: ReturnType<typeof useQueryClient>,
  sessionId: string,
) {
  void queryClient.invalidateQueries({ queryKey: reviewQueryKey(sessionId) });
  void queryClient.invalidateQueries({
    queryKey: ["review", sessionId, "hunks"],
  });
  void queryClient.invalidateQueries({ queryKey: ["git-status"] });
}

export interface StageRequest {
  project: string;
  path: string;
  hunks: number[];
  direction: "stage" | "unstage";
}

/**
 * Stage or unstage hunks.
 *
 * The direction travels with the request because it decides which diff the
 * indexes refer to: staging selects from the worktree against the index,
 * unstaging from the index against HEAD. They are different diffs with
 * independently numbered hunks.
 */
export function useStageHunks(sessionId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (request: StageRequest) =>
      post<ReviewActionResult>(
        `/api/sessions/${sessionId}/review/stage`,
        request,
      ),
    onSuccess: () => invalidateAfterWrite(queryClient, sessionId),
  });
}

export function useCommitReview(sessionId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (request: { project: string; message: string }) =>
      post<ReviewActionResult>(
        `/api/sessions/${sessionId}/review/commit`,
        request,
      ),
    onSuccess: () => invalidateAfterWrite(queryClient, sessionId),
  });
}

/**
 * Save an edit the operator made in the editor.
 *
 * `sha` is what the client last read. The server refuses with 409 when the
 * file moved underneath — which is a real possibility in exactly this panel,
 * since it is open because an agent has been writing to these files.
 */
export function useSaveFile(sessionId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (request: {
      path: string;
      content: string;
      sha?: string;
    }) => {
      const res = await fetch(
        `/api/sessions/${sessionId}/files/content`,
        {
          body: JSON.stringify(request),
          headers: { "Content-Type": "application/json" },
          method: "PUT",
        },
      );
      const payload = (await res.json()) as { error?: string; sha?: string };
      if (!res.ok) throw new Error(payload.error ?? "Unable to save");
      return payload;
    },
    onSuccess: (_data, request) => {
      invalidateAfterWrite(queryClient, sessionId);
      void queryClient.invalidateQueries({
        queryKey: fileContentQueryKey(sessionId, request.path),
      });
    },
  });
}

export interface UncommitPlan {
  allowed: boolean;
  message: string;
  commits: import("@/lib/review-types").TurnCommit[];
  target: string | null;
  pushed: number;
  dirty: boolean;
}

/**
 * Whether the agent's commits can be brought back, and why not if they cannot.
 *
 * Fetched separately from the review itself, and only when the operator is
 * looking at the commits: it costs an ancestry check, an upstream lookup and
 * two rev-lists, none of which is worth doing on every read of a panel that
 * usually has no commits to report.
 */
export function useUncommitPlan(
  sessionId: string,
  project: string | null,
  enabled: boolean,
) {
  return useQuery({
    enabled: Boolean(project) && enabled,
    queryFn: async () => {
      const params = new URLSearchParams({ project: project! });
      const res = await fetch(
        `/api/sessions/${sessionId}/review/uncommit?${params}`,
      );
      if (!res.ok) throw new Error(`uncommit plan ${res.status}`);
      return res.json() as Promise<UncommitPlan>;
    },
    queryKey: ["review", sessionId, "uncommit", project] as const,
    staleTime: 0,
  });
}

export function useUncommit(sessionId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (request: { project: string; target: string }) =>
      post<ReviewActionResult>(
        `/api/sessions/${sessionId}/review/uncommit`,
        request,
      ),
    onSuccess: () => {
      invalidateAfterWrite(queryClient, sessionId);
      void queryClient.invalidateQueries({
        queryKey: ["review", sessionId, "uncommit"],
      });
    },
  });
}
