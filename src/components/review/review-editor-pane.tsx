"use client";

/**
 * One file: the editor, and the hunks of it that can be staged.
 *
 * Split out of the panel frame because it owns a different question. The frame
 * is about which file and which repository; this is about the file itself —
 * what changed in it, what is staged, and whether the operator has unsaved
 * edits in it.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  fetchDefinition,
  fetchLspCompletion,
  fetchLspCompletionResolve,
  fetchLspHover,
  fetchLspPrepareRename,
  fetchLspReferences,
  fetchLspRename,
  fileContentQueryKey,
  notifyLspClose,
  notifyLspSync,
  subscribeToLspDiagnostics,
  useCodeMapAtLine,
  useDismissReviewComment,
  useFileContent,
  useReviewComments,
  useReviewHunks,
  useSymbolAtLine,
  workspacePath,
  type CodeMapAtLine,
  type LspCompletionItem,
  type LspDiagnostic,
} from "@/hooks/use-review";
import { explainFunctionPrompt } from "@/lib/review/review-prompts";
import type { HunkSelector } from "@/lib/pi/review/review-patch";

import { useHunkSplits } from "./review-hunk-splits";

import { isReadOnlyPath } from "./review-definition-target";

import { ReviewCodeMap } from "./review-code-map";

import type { FileSelection } from "./review-changed-files";
import type { CommentSequence } from "./review-comment-widgets";
import type { HunkSlot } from "./review-hunk-cursor";
import { matchFullHunk } from "./review-hunk-match";
import { ReviewEditor } from "./review-editor";
import type { AccessHighlight } from "./review-panel-request";
import type { ReviewComment } from "@/lib/review/review-comment-types";
import { ArrowLeftIcon, ArrowRightIcon, XIcon } from "@phosphor-icons/react";

/**
 * Stable identity for "no comments yet", matching `NO_PROJECTS` in
 * review-panel.tsx: `comments.data ?? []` would otherwise hand the editor a
 * fresh array every render while the query is pending, retriggering its
 * comments effect for no real reason.
 */
const EMPTY_COMMENTS: readonly ReviewComment[] = [];

/** A message pane, for the cases where there is no file to open. */
function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
      <p>{children}</p>
    </div>
  );
}

export function ReviewEditorPane({
  access,
  busy,
  canGoBack,
  canGoForward,
  commentNavigation = null,
  currentHunk = null,
  draft,
  onClose,
  onDraftChange,
  onExplain,
  onGoBack,
  onGoForward,
  onOpenWorkspacePath,
  onSave,
  onStage,
  reveal,
  selection,
  sessionId,
}: {
  /** Whether a previously opened file is available to step back to. */
  canGoBack: boolean;
  /** Whether a file stepped back from is available to step forward to. */
  canGoForward: boolean;
  /** Step to the previously opened file — see `usePanelTarget.goBack`. */
  onGoBack: () => void;
  /** Step to the next opened file — see `usePanelTarget.goForward`. */
  onGoForward: () => void;
  /**
   * The lines the agent read or wrote in this file, from the scrubber.
   *
   * Passed straight through. The pane does not interpret it — the decision of
   * which stop is showing belongs to the panel, and this is only the editor's
   * route to it.
   */
  access: AccessHighlight | null;
  busy: boolean;
  /**
   * The session's whole comment sequence, plus how to open one — what a
   * comment card's next/previous arrows step through.
   *
   * Owned by the panel, not here, for the same reason `reveal` is: stepping
   * to the next comment frequently changes which file is open, and this pane
   * only ever renders the file it was given.
   */
  commentNavigation?: CommentSequence | null;
  /**
   * The keyboard cursor's hunk, when it is in this file — addressed the same
   * way `onStage` is, group-relative into `staged`/`unstaged`, because that
   * is the numbering the cursor holds (review-hunk-cursor.ts). Resolved below
   * against `full`, which is the diff Monaco actually colours.
   */
  currentHunk?: HunkSlot | null;
  /** The operator's unsaved content for this file, or null if untouched. */
  draft: string | null;
  /**
   * Send a prompt into the session. The panel does not own the prompt
   * machinery — the session component does — so "Explain function" builds the
   * text here and hands it up.
   */
  onExplain: (prompt: string) => void;
  /**
   * A line the editor should scroll to, with a counter beside it. The counter
   * is the point: asking for the same line twice has to work, and a bare
   * number would be an unchanged prop the second time.
   *
   * Owned by the panel rather than here, because two things ask for it — a
   * hunk row in the changed-files sidebar, and a content-search hit there
   * too, which also changes which file is open.
   */
  reveal: { line: number; nonce: number } | null;
  /**
   * `dirty` is false when the content is back to what is on disk, so the
   * panel can forget the draft — typing an edit and undoing it should not
   * leave the file counted as unsaved forever.
   */
  onDraftChange: (content: string, dirty: boolean) => void;
  onSave: (content: string, sha: string | undefined) => void;
  /**
   * Stage or unstage hunks of the open file, straight from the editor's own
   * per-hunk gutter buttons — see review-hunk-bracket-widgets.tsx. The same
   * callback the changed-files sidebar's inline hunk list uses; this is a
   * second caller, not a second implementation.
   */
  onStage: (hunks: HunkSelector[], direction: "stage" | "unstage") => void;
  /** Allow closing of the panel */
  onClose: () => void;
  /**
   * Go to Definition landed in another file. The panel owns which file is
   * open, so this hands the workspace-relative path up rather than switching
   * the editor's model underneath itself.
   */
  onOpenWorkspacePath: (workspacePath: string, line: number) => void;
  selection: FileSelection;
  sessionId: string;
}) {
  const hunks = useReviewHunks(sessionId, selection.project, selection.path);
  const content = useFileContent(
    sessionId,
    workspacePath(selection.project, selection.path),
  );
  const comments = useReviewComments(
    sessionId,
    selection.project,
    selection.path,
  );
  const dismissComment = useDismissReviewComment(
    sessionId,
    selection.project,
    selection.path,
  );

  /** The code map the operator asked for, or null when none is open. */
  const [codeMap, setCodeMap] = useState<CodeMapAtLine | null>(null);

  /**
   * Why a context-menu action did nothing.
   *
   * Both actions can legitimately come up empty — a line in an import block is
   * inside no function, and a Markdown or JSON file is not in the TypeScript
   * project at all. A menu item that silently does nothing reads as a bug, so
   * the reason is shown.
   */
  const [notice, setNotice] = useState<string | null>(null);

  const symbolAt = useSymbolAtLine(sessionId);
  const codeMapAt = useCodeMapAtLine(sessionId);

  const queryClient = useQueryClient();

  /**
   * Read a workspace-relative file through the query client rather than a
   * bare fetch, so a target the operator subsequently opens is already
   * cached, and a file read once — by a definition jump, a reference, a
   * rename — does not get read twice. Shared by `definition` and `lsp`
   * below, both of which cross into files other than the one open.
   */
  const readFile = useCallback(
    async (path: string) => {
      try {
        const data = await queryClient.fetchQuery({
          queryFn: async () => {
            const params = new URLSearchParams({ path });
            const res = await fetch(
              `/api/sessions/${sessionId}/files/content?${params}`,
            );
            if (!res.ok) throw new Error("Unable to read file");
            return res.json() as Promise<{ content: string }>;
          },
          queryKey: fileContentQueryKey(sessionId, path),
        });
        return data.content;
      } catch {
        return null;
      }
    },
    [queryClient, sessionId],
  );

  /**
   * Everything Monaco's Go to Definition needs from this session.
   *
   * A single memoised object because `CodeEditor` registers the provider once,
   * for the editor's lifetime, and reads it through a ref — so the identity is
   * not what keeps it current, the closures are. `current` is a function
   * rather than a value for the same reason: the provider is called long after
   * registration, and must see the file open *then*.
   */
  const definition = useMemo(
    () => ({
      current: () => ({ path: selection.path, project: selection.project }),
      languages: ["typescript", "javascript"] as const,
      onCrossFile: onOpenWorkspacePath,
      onNotice: setNotice,
      readFile,
      resolve: (request: {
        project: string;
        path: string;
        line: number;
        character: number;
      }) => fetchDefinition(sessionId, request),
      toWorkspacePath: workspacePath,
    }),
    [
      onOpenWorkspacePath,
      readFile,
      selection.path,
      selection.project,
      sessionId,
    ],
  );

  /**
   * Everything the real language server bridge needs — hover, references,
   * rename, and the project's diagnostics. Same shape as `definition`, same
   * reason: registered once by `CodeEditor`, read through a ref after that.
   *
   * `subscribeDiagnostics` opens one SSE connection per project rather than
   * per file — `lsp-host.ts` pools the language server itself the same way —
   * so its identity only needs to change when the project does, not on every
   * keystroke or file switch within it.
   */
  const lsp = useMemo(
    () => ({
      current: () => ({ path: selection.path, project: selection.project }),
      languages: ["typescript", "javascript"] as const,
      notifyClose: (path: string, project: string) =>
        notifyLspClose(sessionId, project, path),
      notifySync: (path: string, project: string, text: string) =>
        notifyLspSync(sessionId, project, path, text),
      onNotice: setNotice,
      prepareRename: (request: {
        project: string;
        path: string;
        line: number;
        character: number;
      }) => fetchLspPrepareRename(sessionId, request),
      readFile,
      requestHover: (request: {
        project: string;
        path: string;
        line: number;
        character: number;
      }) => fetchLspHover(sessionId, request),
      requestReferences: (request: {
        project: string;
        path: string;
        line: number;
        character: number;
      }) => fetchLspReferences(sessionId, request),
      requestRename: (request: {
        project: string;
        path: string;
        line: number;
        character: number;
        newName: string;
      }) => fetchLspRename(sessionId, request),
      subscribeDiagnostics: (
        onDiagnostics: (path: string, diagnostics: LspDiagnostic[]) => void,
      ) =>
        subscribeToLspDiagnostics(sessionId, selection.project, onDiagnostics),
      toWorkspacePath: workspacePath,
    }),
    [readFile, selection.path, selection.project, sessionId],
  );

  /**
   * Autocomplete. Same shape and same reason as `definition` and `lsp`:
   * registered once by `CodeEditor`, read through a ref after that.
   *
   * No `onNotice`. A position with nothing to suggest is the ordinary case
   * rather than a failure to report — unlike a definition that resolves
   * outside the workspace, there is nothing for the operator to do about it,
   * and a notice bar appearing while they type would be actively in the way.
   */
  const completion = useMemo(
    () => ({
      current: () => ({ path: selection.path, project: selection.project }),
      languages: ["typescript", "javascript"] as const,
      requestCompletion: (request: {
        project: string;
        path: string;
        line: number;
        character: number;
        triggerCharacter?: string;
      }) => fetchLspCompletion(sessionId, request),
      resolveCompletion: (request: {
        project: string;
        path: string;
        item: LspCompletionItem;
      }) => fetchLspCompletionResolve(sessionId, request),
      toWorkspacePath: workspacePath,
    }),
    [selection.path, selection.project, sessionId],
  );

  const status = hunks.data?.file.status;
  const unchanged = hunks.data === null;

  // Stable across re-renders that do not change the hunks themselves — a
  // fresh object here would retrigger CodeEditor's widget-rebuild effect on
  // every keystroke in the draft, tearing down and recreating every stage
  // widget while the operator is typing.
  const staging = useMemo(
    () =>
      hunks.data
        ? { staged: hunks.data.staged, unstaged: hunks.data.unstaged }
        : null,
    [hunks.data],
  );

  /**
   * Where the operator has cut each hunk of this file.
   *
   * Owned here rather than in the panel: a cut is a view of *this* file's
   * diff, keyed by a range that is only meaningful within one file (see
   * `splitKey`). Persisted per repository and path, so it survives a reload
   * and closing the file, until staging or an edit retires its hunk.
   */
  const { addSplit, removeSplit, splits } = useHunkSplits(
    sessionId,
    selection.project,
    selection.path,
  );

  /**
   * The keyboard cursor's hunk, translated into `full`'s numbering.
   *
   * `currentHunk` addresses `staged`/`unstaged` — the diffs staging acts on —
   * while the editor colours from `full`, the diff against HEAD (see
   * `matchHunkAction`'s docblock for why those three are not one diff).
   * `null` while the cursor is in another file, or before this file's own
   * hunks have loaded; either way there is nothing yet to point at.
   */
  const currentFullHunk = useMemo(() => {
    if (!currentHunk || !hunks.data) return null;
    const diff =
      currentHunk.group === "staged" ? hunks.data.staged : hunks.data.unstaged;
    const hunk = diff?.hunks.find(
      (candidate) => candidate.index === currentHunk.index,
    );
    if (!hunk) return null;
    return matchFullHunk(hunk, currentHunk.group, hunks.data.full?.hunks);
  }, [currentHunk, hunks.data]);

  /**
   * Explain: resolve the function, then ask the agent about it.
   *
   * Resolution has to happen first because the browser has no language
   * service — a right-click knows a line and nothing more. Sending a prompt
   * about "line 40" would make the agent do the resolving, less reliably and
   * a model round trip later.
   */
  const explainAt = useCallback(
    (line: number) => {
      symbolAt.mutate(
        { line, path: selection.path, project: selection.project },
        {
          onError: () => setNotice("Unable to resolve that line."),
          onSuccess: (result) => {
            if (!result.symbol) {
              setNotice(
                result.error ??
                  "That line is not inside a function Semla can resolve.",
              );
              return;
            }
            setNotice(null);
            onExplain(
              explainFunctionPrompt({
                changed: !unchanged,
                endLine: result.symbol.endLine,
                path: selection.path,
                project: selection.project,
                startLine: result.symbol.startLine,
                symbol: result.symbol.symbol,
              }),
            );
          },
        },
      );
    },
    [onExplain, selection.path, selection.project, symbolAt, unchanged],
  );

  const visualizeAt = useCallback(
    (line: number) => {
      codeMapAt.mutate(
        { line, path: selection.path, project: selection.project },
        {
          onError: () =>
            setNotice("Unable to build a call graph for that line."),
          onSuccess: (result) => {
            // An error with no map is a fact about the file, not a failure to
            // report as one: show it inline rather than opening an empty panel.
            if (!result.map) {
              setNotice(
                result.error ??
                  "That line is not inside a function Semla can resolve.",
              );
              return;
            }
            setNotice(null);
            setCodeMap(result);
          },
        },
      );
    },
    [codeMapAt, selection.path, selection.project],
  );

  if (status === "deleted") {
    return (
      <Notice>
        <span className="font-mono">{selection.path}</span> was deleted. There
        is nothing left to open — the hunks are all removals, and staging them
        stages the deletion.
      </Notice>
    );
  }

  if (hunks.data?.full?.binary) {
    return (
      <Notice>
        <span className="font-mono">{selection.path}</span> is binary. git
        reports that it changed but cannot say how, so it can only be staged
        whole.
      </Notice>
    );
  }

  if (content.isPending || hunks.isPending) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (content.isError) {
    return <Notice>Unable to read {selection.path}.</Notice>;
  }

  const onDisk = content.data?.content ?? "";
  const dirty = draft !== null && draft !== onDisk;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {notice ? (
        <div className="flex shrink-0 items-center gap-2 border-b bg-muted/40 px-3 py-1">
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {notice}
          </span>
          <Button
            aria-label="Dismiss"
            className="h-6 px-2 text-[11px]"
            onClick={() => setNotice(null)}
            size="sm"
            variant="ghost"
          >
            Dismiss
          </Button>
        </div>
      ) : null}

      {symbolAt.isPending ? (
        <div className="shrink-0 border-b bg-muted/40 px-3 py-1 text-xs text-muted-foreground">
          Resolving the function&hellip;
        </div>
      ) : null}

      <div className="flex shrink-0 items-center gap-2 border-b bg-muted/40 px-2 py-1">
        <div className="flex gap-0">
          <Button
            aria-label="Previous file"
            className="m-0"
            disabled={!canGoBack}
            onClick={onGoBack}
            size="xs"
            variant="ghost"
          >
            <ArrowLeftIcon className="size-3" />
          </Button>
          <Button
            aria-label="Next file"
            className="m-0"
            disabled={!canGoForward}
            onClick={onGoForward}
            size="xs"
            variant="ghost"
          >
            <ArrowRightIcon className="size-3" />
          </Button>
        </div>
        <div className="flex flex-grow justify-center">
          <span className="text-xs">{selection.path}</span>
        </div>
        <div className="flex ml-auto">
          <Button
            aria-label="Close review"
            onClick={onClose}
            size="xs"
            variant="ghost"
          >
            <XIcon className="size-3" />
          </Button>
        </div>
      </div>

      {dirty ? (
        <div className="flex shrink-0 items-center gap-2 border-b bg-muted/40 px-3 py-1">
          <span className="text-xs text-muted-foreground">Unsaved edits</span>
          <Button
            className="ml-auto h-6 px-2 text-[11px]"
            disabled={busy}
            onClick={() => onSave(draft, content.data?.sha)}
            size="sm"
            variant="secondary"
          >
            Save
          </Button>
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        {/* Over the editor rather than instead of it: the model holds the
            operator's unsaved edits, and unmounting it would drop them. */}
        {codeMap || codeMapAt.isPending ? (
          <ReviewCodeMap
            onClose={() => setCodeMap(null)}
            pending={codeMapAt.isPending}
            result={codeMap}
          />
        ) : null}

        <ReviewEditor
          access={access}
          commentNavigation={commentNavigation}
          comments={comments.data ?? EMPTY_COMMENTS}
          completion={completion}
          currentHunk={currentFullHunk}
          definition={definition}
          lsp={lsp}
          hunkSplits={splits}
          hunks={hunks.data?.full?.hunks ?? []}
          onChange={(next) => onDraftChange(next, next !== onDisk)}
          onDismissComment={(id) => dismissComment.mutate(id)}
          onExplainLine={explainAt}
          onMergeHunk={removeSplit}
          onSplitHunk={addSplit}
          onStageHunk={onStage}
          onVisualizeLine={visualizeAt}
          reveal={reveal}
          onSave={() => onSave(draft ?? onDisk, content.data?.sha)}
          path={selection.path}
          project={selection.project}
          // A declaration file or a dependency opened by Go to Definition is
          // not this repository's to change: editing it would produce a diff
          // the review panel cannot show and `npm ci` would erase.
          readOnly={isReadOnlyPath(
            workspacePath(selection.project, selection.path),
          )}
          staging={staging}
          stagingBusy={busy}
          value={onDisk}
        />
      </div>
    </div>
  );
}
