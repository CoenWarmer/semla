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

export interface EnclosingSymbol {
  symbol: string;
  name: string;
  container: string | null;
  startLine: number;
  endLine: number;
}

export interface SymbolAtLine {
  symbol: EnclosingSymbol | null;
  error?: string;
}

/**
 * Which function a line is inside.
 *
 * A mutation rather than a query: it is asked in response to a right-click at
 * a particular line, not kept warm for a position nobody has chosen yet.
 */
export function useSymbolAtLine(sessionId: string) {
  return useMutation({
    mutationFn: async (request: {
      project: string;
      path: string;
      line: number;
    }) => {
      const res = await fetch(`/api/sessions/${sessionId}/review/symbol`, {
        body: JSON.stringify(request),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      return (await res.json()) as SymbolAtLine;
    },
  });
}

/**
 * Resolving a definition, and reading a file that is not the one open.
 *
 * Both are plain functions rather than hooks: they are called from inside
 * Monaco's definition provider, which is not a React context and cannot hold
 * a mutation. `queryClient` is passed in so a file read for a definition
 * populates — and reuses — the same cache the editor reads from.
 */
export type DefinitionAnswer = {
  definition: {
    path: string | null;
    line: number;
    name: string;
    external: boolean;
  } | null;
  error?: string;
};

export async function fetchDefinition(
  sessionId: string,
  request: { project: string; path: string; line: number; character: number },
): Promise<DefinitionAnswer | null> {
  const res = await fetch(`/api/sessions/${sessionId}/review/definition`, {
    body: JSON.stringify(request),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

  // A 4xx here is a position that cannot be resolved — a Markdown file, a
  // project with no tsconfig — which is a fact about the file rather than a
  // failure worth surfacing on a hover. `definition: null` is the same
  // "nothing to go to" the gesture already handles.
  if (!res.ok) return { definition: null };

  return (await res.json()) as DefinitionAnswer;
}

export interface CodeMapAtLine {
  map: import("@/lib/code-map/types").CodeMap | null;
  symbol?: EnclosingSymbol;
  error?: string;
}

/**
 * The call graph around the function at a line.
 *
 * One request that resolves the symbol and builds the map together. Splitting
 * them would be a race: the operator can edit between the two calls, and the
 * second would map a function the first found at a line that has since moved.
 */
export function useCodeMapAtLine(sessionId: string) {
  return useMutation({
    mutationFn: async (request: {
      project: string;
      path: string;
      line: number;
    }) => {
      const res = await fetch(`/api/sessions/${sessionId}/review/code-map`, {
        body: JSON.stringify(request),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      return (await res.json()) as CodeMapAtLine;
    },
  });
}

export interface ContentMatch {
  path: string;
  line: number;
  text: string;
}

/**
 * Lines in the project containing the query.
 *
 * Its own query rather than part of the name search: content takes longer to
 * sweep than names, and sharing one request would hold the names — which
 * usually answer the question on their own — behind it.
 */
export function useContentSearch(
  sessionId: string,
  project: string | null,
  query: string,
) {
  return useQuery({
    enabled: Boolean(project) && query.length >= 3,
    queryFn: async () => {
      const params = new URLSearchParams({ project: project!, q: query });
      const res = await fetch(
        `/api/sessions/${sessionId}/review/grep?${params}`,
      );
      if (!res.ok) throw new Error(`grep ${res.status}`);
      return res.json() as Promise<{
        matches: ContentMatch[];
        truncated: boolean;
      }>;
    },
    // Keeps the previous hits on screen while the next sweep runs, so the list
    // does not blank on every keystroke.
    placeholderData: (previous) => previous,
    queryKey: ["review", sessionId, "grep", project, query] as const,
    staleTime: 30_000,
  });
}
