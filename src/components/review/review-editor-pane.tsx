"use client";

/**
 * One file: the editor, and the hunks of it that can be staged.
 *
 * Split out of the panel frame because it owns a different question. The frame
 * is about which file and which repository; this is about the file itself —
 * what changed in it, what is staged, and whether the operator has unsaved
 * edits in it.
 */

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  useFileContent,
  useReviewHunks,
  workspacePath,
} from "@/hooks/use-review";

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
  onSave,
  onStage,
  selection,
  sessionId,
}: {
  busy: boolean;
  /** The operator's unsaved content for this file, or null if untouched. */
  draft: string | null;
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

  /**
   * A line the editor should scroll to, with a counter beside it.
   *
   * The counter is the point: clicking the same hunk twice has to work, and a
   * bare line number would be an unchanged prop the second time. Passed as
   * data rather than reached for through a ref, because the editor is behind a
   * dynamic import and a plain prop crosses that boundary without ceremony.
   */
  const [reveal, setReveal] = useState<{ line: number; nonce: number } | null>(
    null,
  );

  const status = hunks.data?.file.status;
  const unchanged = hunks.data === null;

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

        <div className="min-h-0 flex-1">
          <ReviewEditor
            hunks={hunks.data?.full?.hunks ?? []}
            onChange={(next) => onDraftChange(next, next !== onDisk)}
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
          onReveal={(line) =>
            setReveal((previous) => ({ line, nonce: (previous?.nonce ?? 0) + 1 }))
          }
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
