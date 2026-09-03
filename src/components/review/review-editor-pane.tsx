"use client";

/**
 * One file: the editor, and the hunks of it that can be staged.
 *
 * Split out of the panel frame because it owns a different question. The frame
 * is about which file and which repository; this is about the file itself —
 * what changed in it, what is staged, and whether the operator has unsaved
 * edits in it.
 */

import { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  useCodeMapAtLine,
  useFileContent,
  useReviewHunks,
  useSymbolAtLine,
  workspacePath,
  type CodeMapAtLine,
} from "@/hooks/use-review";
import { explainFunctionPrompt } from "@/lib/review-prompts";

import { ReviewCodeMap } from "./review-code-map";

import type { FileSelection } from "./review-changed-files";
import { ReviewEditor } from "./review-editor";
import { ReviewHunkList } from "./review-hunk-list";

const HUNKS_WIDTH = 260;

/** A message pane, for the cases where there is no file to open. */
function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
      <p>{children}</p>
    </div>
  );
}

export function ReviewEditorPane({
  busy,
  draft,
  onDraftChange,
  onExplain,
  onReveal,
  onSave,
  onStage,
  reveal,
  selection,
  sessionId,
}: {
  busy: boolean;
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
   * hunk row in this pane, and a content-search hit in the sidebar, which also
   * changes which file is open.
   */
  reveal: { line: number; nonce: number } | null;
  onReveal: (line: number) => void;
  /**
   * `dirty` is false when the content is back to what is on disk, so the
   * panel can forget the draft — typing an edit and undoing it should not
   * leave the file counted as unsaved forever.
   */
  onDraftChange: (content: string, dirty: boolean) => void;
  onSave: (content: string, sha: string | undefined) => void;
  onStage: (hunks: number[], direction: "stage" | "unstage") => void;
  selection: FileSelection;
  sessionId: string;
}) {
  const hunks = useReviewHunks(sessionId, selection.project, selection.path);
  const content = useFileContent(
    sessionId,
    workspacePath(selection.project, selection.path),
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

  const status = hunks.data?.file.status;
  const unchanged = hunks.data === null;

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
          onError: () => setNotice("Unable to build a call graph for that line."),
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
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
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

        {dirty ? (
          <div className="flex shrink-0 items-center gap-2 border-b bg-muted/40 px-3 py-1">
            <span className="text-xs text-muted-foreground">
              Unsaved edits in {selection.path}
            </span>
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
            hunks={hunks.data?.full?.hunks ?? []}
            onChange={(next) => onDraftChange(next, next !== onDisk)}
            onExplainLine={explainAt}
            onVisualizeLine={visualizeAt}
            reveal={reveal}
            onSave={() => onSave(draft ?? onDisk, content.data?.sha)}
            path={selection.path}
            value={onDisk}
          />
        </div>
      </div>

      {/* An unchanged file opened from the tree has nothing to stage, and an
          empty column of controls would only invite clicking them. */}
      {unchanged ? null : (
      <aside
        className="shrink-0 overflow-y-auto border-l"
        style={{ width: HUNKS_WIDTH }}
      >
        <ReviewHunkList
          busy={busy}
          onReveal={onReveal}
          onStage={onStage}
          staged={hunks.data?.staged ?? null}
          unstaged={hunks.data?.unstaged ?? null}
          untracked={hunks.data?.untracked ?? false}
        />
      </aside>
      )}
    </div>
  );
}
