"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { sessionStatusKey } from "@/lib/session/session-status";
import type { FileDiff } from "@/lib/review/review-types";
import type { ChangedFile, SessionReview } from "@/lib/review/review-types";
import type { ReviewComment } from "@/lib/review/review-comment-types";

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

/**
 * `sha` is part of the key, not an argument the fetcher merely happens to
 * carry: a commit's hunks and the working tree's hunks for the same file are
 * different answers, and sharing one cache entry between them would serve
 * whichever was fetched first when the operator switched commit dots.
 */
export const reviewHunksQueryKey = (
  sessionId: string,
  project: string | null,
  path: string | null,
  sha: string | null = null,
) => ["review", sessionId, "hunks", project, path, sha] as const;

/**
 * A file's own comments, keyed the same way `reviewHunksQueryKey` is but
 * with no `sha`: a comment anchors to a file's own lines, not to a
 * particular commit's view of it — there is exactly one live list per file,
 * regardless of which commit dot the panel happens to be showing.
 */
export const reviewCommentsQueryKey = (
  sessionId: string,
  project: string | null,
  path: string | null,
) => ["review", sessionId, "comments", project, path] as const;

async function fetchReview(sessionId: string): Promise<SessionReview> {
  const res = await fetch(`/api/sessions/${sessionId}/review`);
  if (!res.ok) throw new Error(`review ${res.status}`);
  return res.json();
}

async function fetchReviewComments(
  sessionId: string,
  project: string,
  path: string,
): Promise<ReviewComment[]> {
  const params = new URLSearchParams({ path, project });
  const res = await fetch(`/api/sessions/${sessionId}/review/comments?${params}`);
  if (!res.ok) throw new Error(`review comments ${res.status}`);
  const body = (await res.json()) as { comments: ReviewComment[] };
  return body.comments;
}

/**
 * A file's live comments — created either by a past `open_review` call
 * (read here, on open) or, live, by the current turn's SSE stream (merged
 * in by the caller; see review-editor-pane.tsx). Not polled, same reasoning
 * as `useReview`: nothing here changes on its own between fetches.
 */
export function useReviewComments(
  sessionId: string,
  project: string | null,
  path: string | null,
) {
  return useQuery({
    enabled: Boolean(project && path),
    queryFn: () => fetchReviewComments(sessionId, project!, path!),
    queryKey: reviewCommentsQueryKey(sessionId, project, path),
    staleTime: 0,
  });
}

/**
 * Dismiss one comment. Optimistic: the panel removes it from the visible
 * list immediately rather than waiting on a refetch, same UX choice
 * `useDismissReview` makes for the whole-review dismissal.
 */
export function useDismissReviewComment(
  sessionId: string,
  project: string | null,
  path: string | null,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (commentId: string) => {
      const res = await fetch(`/api/sessions/${sessionId}/review/comments/${commentId}`, {
        method: "PATCH",
      });
      if (!res.ok) throw new Error("Unable to dismiss the comment");
      return commentId;
    },
    onSuccess: (commentId) => {
      queryClient.setQueryData<ReviewComment[]>(
        reviewCommentsQueryKey(sessionId, project, path),
        (previous) => previous?.filter((comment) => comment.id !== commentId) ?? previous,
      );
    },
  });
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
  /**
   * Null when these hunks are a commit's: a commit has no index, so there is
   * nothing staged and nothing left unstaged. The staging controls read these
   * rather than a separate flag, so null is what makes a commit's hunk list
   * read-only.
   */
  staged: FileDiff | null;
  unstaged: FileDiff | null;
  untracked: boolean;
  file: ChangedFile;
  project: string;
  /** The commit these hunks are from, absent for the working tree. */
  commitSha?: string;
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
  sha: string | null,
): Promise<FileHunks | null> {
  const params = new URLSearchParams({ path, project });
  if (sha) params.set("sha", sha);
  const res = await fetch(`/api/sessions/${sessionId}/review/hunks?${params}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`hunks ${res.status}`);
  return res.json();
}

/**
 * One file's hunks, from the working tree or from a commit.
 *
 * With `sha` the route answers from that commit and does not consult the
 * working tree at all, which is the only way to show a file that was committed
 * and is clean now — `git status` does not report it, so the working-tree read
 * 404s exactly the files a commit selection exists to show.
 */
export function useReviewHunks(
  sessionId: string,
  project: string | null,
  path: string | null,
  sha: string | null = null,
) {
  return useQuery({
    enabled: Boolean(project && path),
    queryFn: () => fetchHunks(sessionId, project!, path!, sha),
    queryKey: reviewHunksQueryKey(sessionId, project, path, sha),
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

/**
 * Every file-content query this session holds, regardless of path.
 *
 * `fileContentQueryKey` narrows to one path; invalidating that alone leaves
 * every other cached file — including whichever one the editor has open —
 * stale after something outside a save changes it on disk, such as a turn
 * finishing. This is the prefix TanStack matches all of them against.
 */
export const fileContentQueryKeyPrefix = (sessionId: string) =>
  ["session-file-content", sessionId] as const;

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
 *
 * `sessionStatusKey` is in this list because it is the *other* place HEAD
 * moving matters: the session summary card's artifact groups (see
 * artifact-groups.ts) come from `SingleSessionStatus.artifacts`, which this
 * hook does not otherwise touch. Without this, staging correctly drops a
 * file from the card's "uncommitted diff" row via `useReview`'s own refetch,
 * but the new commit never appears — nothing told the status query a commit
 * had happened, so it kept serving the pre-commit artifact snapshot until
 * its own poll interval caught up.
 */
export function invalidateAfterWrite(
  queryClient: ReturnType<typeof useQueryClient>,
  sessionId: string,
): Promise<void> {
  // Awaited by the mutations below, so a mutation's success does not
  // resolve until the review state it invalidated has actually refetched —
  // otherwise a caller that reacts to `onSuccess` (or awaits `mutateAsync`)
  // can render against the stale `staged` count for one more frame, which is
  // exactly the window where the commit bar's visibility check runs.
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: reviewQueryKey(sessionId) }),
    queryClient.invalidateQueries({
      queryKey: ["review", sessionId, "hunks"],
    }),
    queryClient.invalidateQueries({ queryKey: ["git-status"] }),
    queryClient.invalidateQueries({ queryKey: sessionStatusKey(sessionId) }),
  ]).then(() => undefined);
}

export interface StageRequest {
  project: string;
  path: string;
  hunks: number[];
  direction: "stage" | "unstage";
  /**
   * Stage or unstage the whole file, ignoring `hunks` entirely.
   *
   * Used by drag-to-stage: a row dropped into a bucket has not necessarily
   * had its diff fetched, and "stage this file" has no hunk indexes to send.
   * See the route's docblock for why this is the same `git add` /
   * `git restore --staged` an untracked file already went through.
   */
  whole?: boolean;
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
    onSuccess: (_data, request) =>
      Promise.all([
        invalidateAfterWrite(queryClient, sessionId),
        queryClient.invalidateQueries({
          queryKey: fileContentQueryKey(sessionId, request.path),
        }),
      ]).then(() => undefined),
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

/**
 * Hover, references and rename, backed by the real language server the
 * `review/lsp/*` routes bridge to — see `lsp-host.ts` for what runs behind
 * them, and `lsp-provider.ts` for the Monaco side these feed.
 *
 * Positions throughout are one-based (Monaco's convention, and this file's
 * own — see `fetchDefinition` above); the routes convert to and from LSP's
 * zero-based ones at the one seam that has to know both.
 *
 * These types mirror the wire shape rather than importing it from
 * `lsp-translate.ts`, the same choice `DefinitionAnswer` above already makes
 * against `code-map/definition.ts`: this file has no reason to reach into
 * `components/review` for a shape it can just restate.
 */
export type LspPosition = { line: number; character: number };
export type LspRange = { start: LspPosition; end: LspPosition };

export type LspHoverAnswer = {
  contents:
    | string
    | { kind: "markdown" | "plaintext"; value: string }
    | { language: string; value: string }
    | Array<string | { language: string; value: string }>;
  range?: LspRange;
} | null;

export type LspDiagnostic = {
  range: LspRange;
  /** LSP's own numbering: Error 1, Warning 2, Information 3, Hint 4. */
  severity?: 1 | 2 | 3 | 4;
  message: string;
  source?: string;
  code?: string | number;
};

export type LspTextEdit = { range: LspRange; newText: string };
export type LspRenameFile = { path: string; edits: LspTextEdit[] };
export type LspReferenceLocation = { path: string; range: LspRange };
export type LspPrepareRenameAnswer =
  | LspRange
  | { range: LspRange; placeholder?: string }
  | null;

export type LspRequestBody = {
  project: string;
  path: string;
  line: number;
  character: number;
};

async function fetchLspRequest<T>(
  sessionId: string,
  method: "hover" | "references" | "prepareRename" | "rename",
  body: LspRequestBody & { newName?: string },
): Promise<T | null> {
  try {
    const res = await fetch(`/api/sessions/${sessionId}/review/lsp/request`, {
      body: JSON.stringify({ ...body, method }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    // A 4xx/5xx here is the same "nothing to answer" outcome fetchDefinition
    // treats a failed resolution as — a position with no hover, a language
    // server that has not started yet — rather than something to throw over.
    if (!res.ok) return null;
    const { result } = (await res.json()) as { result: T };
    return result;
  } catch {
    return null;
  }
}

export const fetchLspHover = (sessionId: string, body: LspRequestBody) =>
  fetchLspRequest<LspHoverAnswer>(sessionId, "hover", body);

export const fetchLspReferences = (sessionId: string, body: LspRequestBody) =>
  fetchLspRequest<LspReferenceLocation[]>(sessionId, "references", body);

export const fetchLspPrepareRename = (sessionId: string, body: LspRequestBody) =>
  fetchLspRequest<LspPrepareRenameAnswer>(sessionId, "prepareRename", body);

export const fetchLspRename = (
  sessionId: string,
  body: LspRequestBody & { newName: string },
) => fetchLspRequest<{ files: LspRenameFile[] }>(sessionId, "rename", body);

/**
 * Buffer sync and close, fire-and-forget.
 *
 * Neither has an answer worth waiting for — the panel already has its own
 * copy of the text, and a dropped notification is caught up on the next
 * keystroke or the next file open. Errors are swallowed for the same reason
 * `readFile`'s catch above returns null rather than throwing: a language
 * server that is not running yet is not this call's failure to report.
 */
export function notifyLspSync(
  sessionId: string,
  project: string,
  path: string,
  text: string,
): void {
  void fetch(`/api/sessions/${sessionId}/review/lsp/notify`, {
    body: JSON.stringify({ method: "didOpen", path, project, text }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  }).catch(() => {});
}

export function notifyLspClose(
  sessionId: string,
  project: string,
  path: string,
): void {
  void fetch(`/api/sessions/${sessionId}/review/lsp/notify`, {
    body: JSON.stringify({ method: "didClose", path, project }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  }).catch(() => {});
}

/**
 * Attach to a project's diagnostics, replayed-on-attach and pushed after.
 *
 * The same framing and the same reader loop the terminal's SSE stream uses
 * (`app-terminal.tsx`) — this repository's one pattern for a server that
 * pushes rather than answers. Returns an unsubscribe that aborts the
 * underlying fetch; the language server itself is not stopped by it — see
 * `lsp-host.ts` on why that is the idle sweep's job instead.
 */
export function subscribeToLspDiagnostics(
  sessionId: string,
  project: string,
  onDiagnostics: (path: string, diagnostics: LspDiagnostic[]) => void,
): () => void {
  const abort = new AbortController();

  const run = async () => {
    const params = new URLSearchParams({ project });
    const response = await fetch(
      `/api/sessions/${sessionId}/review/lsp/diagnostics?${params}`,
      { signal: abort.signal },
    );
    if (!response.ok || !response.body) return;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";

      for (const frame of frames) {
        const line = frame.split("\n").find((entry) => entry.startsWith("data: "));
        if (!line) continue;
        const { path, diagnostics } = JSON.parse(line.slice(6)) as {
          path: string;
          diagnostics: LspDiagnostic[];
        };
        onDiagnostics(path, diagnostics);
      }
    }
  };

  run().catch((cause: unknown) => {
    if ((cause as Error)?.name === "AbortError") return;
    console.error("[lsp diagnostics]", cause);
  });

  return () => abort.abort();
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
