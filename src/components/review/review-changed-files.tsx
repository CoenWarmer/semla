"use client";

/**
 * The bucket of changed files, above the tree.
 *
 * Above rather than inside it, deliberately: what a turn changed is a short
 * list the operator wants whole, and burying eight files inside a tree of four
 * thousand is what this panel exists to avoid. The tree underneath is for
 * looking at everything else — the file that was *not* changed but should have
 * been is a review finding too.
 *
 * Each row folds open to show its hunks, staging controls included — see
 * `ReviewHunkList`. That list used to be a fixed sidebar beside the editor;
 * it moved here so that picking a file and seeing what to stage in it are the
 * same click, and so the editor pane no longer needs to spend width on a
 * second, separate list.
 */

import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import type { ChangedFile, ProjectReview } from "@/lib/review-types";
import { useReviewHunks } from "@/hooks/use-review";
import { Spinner } from "@/components/ui/spinner";

import {
  renameLabel,
  splitPath,
  STATUS_LABEL,
  STATUS_TONE,
  TONE_CLASS,
} from "./review-file-display";
import { ReviewHunkList } from "./review-hunk-list";

export interface FileSelection {
  project: string;
  path: string;
}

/** The hunks of one expanded file, fetched only while it is open. */
function ExpandedHunks({
  busy,
  onReveal,
  onStage,
  selection,
  sessionId,
}: {
  busy: boolean;
  onReveal: (line: number) => void;
  onStage: (hunks: number[], direction: "stage" | "unstage") => void;
  selection: FileSelection;
  sessionId: string;
}) {
  const hunks = useReviewHunks(sessionId, selection.project, selection.path);

  if (hunks.isPending) {
    return (
      <div className="flex justify-center py-3">
        <Spinner />
      </div>
    );
  }

  // A 404 from the hunks route — see useReviewHunks — means git has nothing
  // to say about this path, which should not happen for a file this list is
  // already showing as changed. Rather than claim there is nothing to stage,
  // say plainly that the read failed.
  if (!hunks.data) {
    return (
      <p className="px-2 py-2 text-[11px] text-muted-foreground">
        Unable to read this file&rsquo;s hunks.
      </p>
    );
  }

  // git declined to diff it, so there are no hunks to choose between —
  // ReviewHunkList's groups would all render empty here, which reads as a
  // bug rather than as "nothing to show". The editor pane says the same for
  // the file itself; this is that notice's counterpart for the hunk list.
  if (hunks.data.full?.binary) {
    return (
      <p className="px-2 py-2 text-[11px] text-muted-foreground">
        This file is binary — it can only be staged whole.
      </p>
    );
  }

  return (
    <ReviewHunkList
      busy={busy}
      onReveal={onReveal}
      onStage={onStage}
      staged={hunks.data.staged}
      unstaged={hunks.data.unstaged}
      untracked={hunks.data.untracked}
    />
  );
}

function FileRow({
  busy,
  expanded,
  file,
  onReveal,
  onStage,
  onToggle,
  project,
  selected,
  sessionId,
}: {
  busy: boolean;
  expanded: boolean;
  file: ChangedFile;
  onReveal: (line: number) => void;
  onStage: (hunks: number[], direction: "stage" | "unstage") => void;
  onToggle: () => void;
  project: string;
  selected: boolean;
  sessionId: string;
}) {
  const { dir } = splitPath(file.path);
  const tone = TONE_CLASS[STATUS_TONE[file.status]];

  return (
    <div>
      <button
        className={cn(
          "flex w-full items-baseline gap-2 rounded px-2 py-1 text-left text-xs transition-colors",
          selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
        )}
        onClick={onToggle}
        title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        type="button"
      >
        {expanded ? (
          <ChevronDownIcon className="size-3 shrink-0 self-center text-muted-foreground" />
        ) : (
          <ChevronRightIcon className="size-3 shrink-0 self-center text-muted-foreground" />
        )}

        <span className={cn("w-3 shrink-0 font-mono", tone)}>
          {STATUS_LABEL[file.status]}
        </span>

        <span className="min-w-0 flex-1 truncate">
          {dir && !file.oldPath ? (
            <span className="text-muted-foreground">{dir}</span>
          ) : null}
          <span>{renameLabel(file.oldPath, file.path)}</span>
        </span>

        {/* What a commit would include right now, without opening the file. */}
        {file.staged ? (
          <span
            className="shrink-0 text-[10px] text-muted-foreground"
            title="Staged"
          >
            staged
          </span>
        ) : null}
      </button>

      {expanded ? (
        <div className="pl-3">
          <ExpandedHunks
            busy={busy}
            onReveal={onReveal}
            onStage={onStage}
            selection={{ path: file.path, project }}
            sessionId={sessionId}
          />
        </div>
      ) : null}
    </div>
  );
}

export function ReviewChangedFiles({
  busy,
  expanded,
  onReveal,
  onSelect,
  onStage,
  projects,
  selected,
  sessionId,
}: {
  busy: boolean;
  /** The one file currently folded open, or null when none is. */
  expanded: FileSelection | null;
  onReveal: (line: number) => void;
  /**
   * Clicking a row both opens it in the editor and folds its hunks open —
   * one action, not two, so there is no separate "select" the operator has
   * to remember to also do.
   */
  onSelect: (selection: FileSelection) => void;
  onStage: (hunks: number[], direction: "stage" | "unstage") => void;
  projects: readonly ProjectReview[];
  selected: FileSelection | null;
  sessionId: string;
}) {
  const withChanges = projects.filter(
    (project) => project.changedFiles.length > 0,
  );

  if (withChanges.length === 0) {
    return (
      <p className="px-2 py-3 text-xs text-muted-foreground">
        Nothing has changed in this session&rsquo;s projects.
      </p>
    );
  }

  // Only name the project when there is more than one; a single-project
  // session does not need a heading repeating what the panel title says.
  const showHeadings = withChanges.length > 1;

  return (
    <div className="flex flex-col gap-2">
      {withChanges.map((project) => (
        <div key={project.path}>
          {showHeadings ? (
            <p className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {project.name}
            </p>
          ) : null}

          <div className="flex flex-col">
            {project.changedFiles.map((file) => (
              <FileRow
                busy={busy}
                expanded={
                  expanded?.project === project.path &&
                  expanded.path === file.path
                }
                file={file}
                key={`${project.path}/${file.path}`}
                onReveal={onReveal}
                onStage={onStage}
                onToggle={() =>
                  onSelect({ path: file.path, project: project.path })
                }
                project={project.path}
                selected={
                  selected?.project === project.path &&
                  selected.path === file.path
                }
                sessionId={sessionId}
              />
            ))}
          </div>

          {project.omitted > 0 ? (
            <p className="px-2 pt-1 text-[10px] text-muted-foreground">
              {project.omitted} more not listed
            </p>
          ) : null}
        </div>
      ))}
    </div>
  );
}
