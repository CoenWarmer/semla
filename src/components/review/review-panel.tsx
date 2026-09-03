"use client";

/**
 * The review surface: what the turn changed, in a repository, with the file
 * open beside it.
 *
 * A fixed overlay rather than a portal. The bottom bar had to portal because
 * the *bar* lives in the root layout while its data belongs to the session —
 * neither side could own both. Here there is no such split: the data is the
 * session's and fixed positioning already escapes the layout flow, so the
 * session tree renders it directly and keeps its subscriptions.
 *
 * The 20px sides and 40px top are the specified frame. The bottom is not: it
 * stops above the console bar rather than covering it, because that bar hosts
 * the agent timeline and the terminal, and hiding the controls that describe a
 * run while reviewing that run's output is the wrong trade.
 */

import { XIcon } from "lucide-react";
import { useState } from "react";

import { CONSOLE_BAR_HEIGHT, useBottomPanel } from "@/components/bottom-panel";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  useFileContent,
  useReview,
  useReviewHunks,
  workspacePath,
} from "@/hooks/use-review";
import { isEmptyReview, totalChangedFiles, totalTurnCommits } from "@/lib/review-types";
import type { SessionReview } from "@/lib/review-types";

import {
  ReviewChangedFiles,
  type FileSelection,
} from "./review-changed-files";
import { ReviewEditor } from "./review-editor";
import { splitPath } from "./review-file-display";

const SIDEBAR_WIDTH = 300;

/** The frame the panel is specified to sit in. */
const INSET = { left: 20, right: 20, top: 40 } as const;

/**
 * The first thing worth showing: the anchor project's first changed file.
 *
 * Derived during render rather than pushed into state by an effect. Selecting
 * a default in an effect is the `react/set-state-in-effect` error this
 * repository treats as fatal, and it also flashes an empty pane for a frame.
 */
function defaultSelection(review: SessionReview | undefined): FileSelection | null {
  for (const project of review?.projects ?? []) {
    const first = project.changedFiles[0];
    if (first) return { path: first.path, project: project.path };
  }
  return null;
}

function EditorPane({
  selection,
  sessionId,
}: {
  selection: FileSelection;
  sessionId: string;
}) {
  const hunks = useReviewHunks(sessionId, selection.project, selection.path);
  const content = useFileContent(
    sessionId,
    workspacePath(selection.project, selection.path),
  );

  const status = hunks.data?.file.status;

  // A deleted file has no content to open. Saying so is the whole answer:
  // there is nothing to edit and the hunks are all removals.
  if (status === "deleted") {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        <p>
          <span className="font-mono">{selection.path}</span> was deleted in
          this turn. There is nothing left to open.
        </p>
      </div>
    );
  }

  if (hunks.data?.full?.binary) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        <p>
          <span className="font-mono">{selection.path}</span> is binary. git
          reports it changed but cannot say how.
        </p>
      </div>
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
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-destructive">
        <p>Unable to read {selection.path}.</p>
      </div>
    );
  }

  return (
    <ReviewEditor
      hunks={hunks.data?.full?.hunks ?? []}
      path={selection.path}
      value={content.data?.content ?? ""}
    />
  );
}

export function ReviewPanel({
  onClose,
  sessionId,
}: {
  onClose: () => void;
  sessionId: string;
}) {
  const review = useReview(sessionId);
  const [chosen, setChosen] = useState<FileSelection | null>(null);
  const panel = useBottomPanel();

  const selection = chosen ?? defaultSelection(review.data);
  const bottom = (panel?.open ? panel.height : 0) + CONSOLE_BAR_HEIGHT;

  const changed = review.data ? totalChangedFiles(review.data) : 0;
  const commits = review.data ? totalTurnCommits(review.data) : 0;
  const anchor = review.data?.projects[0];

  return (
    <div
      aria-label="Review changes"
      className="fixed z-40 flex flex-col overflow-hidden rounded-lg border bg-background shadow-2xl"
      role="dialog"
      style={{ bottom, left: INSET.left, right: INSET.right, top: INSET.top }}
    >
      <header className="flex shrink-0 items-center gap-3 border-b px-3 py-2">
        <h2 className="text-sm font-medium">Review</h2>

        {anchor ? (
          <span className="text-xs text-muted-foreground">{anchor.name}</span>
        ) : null}

        <span className="text-xs text-muted-foreground">
          {changed} changed {changed === 1 ? "file" : "files"}
          {commits > 0
            ? `, ${commits} commit${commits === 1 ? "" : "s"} this turn`
            : ""}
        </span>

        <div className="ml-auto flex items-center gap-2">
          {selection ? (
            <span className="font-mono text-xs text-muted-foreground">
              {splitPath(selection.path).name}
            </span>
          ) : null}

          <Button aria-label="Close review" onClick={onClose} size="icon" variant="ghost">
            <XIcon className="size-4" />
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside
          className="flex shrink-0 flex-col overflow-y-auto border-r py-2"
          style={{ width: SIDEBAR_WIDTH }}
        >
          {review.isPending ? (
            <div className="flex justify-center py-4">
              <Spinner />
            </div>
          ) : (
            <ReviewChangedFiles
              onSelect={setChosen}
              projects={review.data?.projects ?? []}
              selected={selection}
            />
          )}
        </aside>

        <main className="min-w-0 flex-1">
          {selection ? (
            <EditorPane selection={selection} sessionId={sessionId} />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {review.data && isEmptyReview(review.data)
                ? "Nothing to review."
                : "Select a file."}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
