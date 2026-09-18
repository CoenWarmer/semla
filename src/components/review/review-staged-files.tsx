"use client";

/**
 * What a commit would include right now, for one project — the subset of
 * `ReviewChangedFiles`' rows whose `staged` flag is set.
 *
 * A separate list rather than a filter toggle on the one below: "what will
 * be committed" and "what changed" are different questions, and an operator
 * checking the first should not have to first find it inside the second.
 *
 * Rows here are not `FileRow`: there is nothing to fold open, so there is
 * nothing to toggle. A file is in this list because it is staged, and its
 * staged hunks are exactly what it takes to explain that — always shown,
 * with no chevron pretending there is a collapsed state to expand into.
 *
 * The header is a button rather than static text: clicking a staged file's
 * path opens it in the editor pane, the same as clicking its row in the
 * full changed-files list below.
 */

import { useReviewHunks } from "@/hooks/use-review";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type { ChangedFile } from "@/lib/review/review-types";

import {
  splitPath,
  STATUS_LABEL,
  STATUS_TONE,
  TONE_CLASS,
} from "./review-file-display";
import type { FileSelection, StageFileHunks } from "./review-changed-files";
import { ReviewHunkList } from "./review-hunk-list";
import { sameFile, type HunkSlot } from "./review-hunk-cursor";
import type { HunkCursorPosition } from "./review-hunk-keyboard";

/** One staged file: its path, and its staged hunks, always open. */
function StagedFileRow({
  busy,
  currentHunk = null,
  file,
  onReveal,
  onSelect,
  onStage,
  project,
  sessionId,
}: {
  busy: boolean;
  /** The hunk the keyboard cursor is on, when it is in this file. */
  currentHunk?: HunkSlot | null;
  file: ChangedFile;
  onReveal: (line: number) => void;
  onSelect: (selection: FileSelection) => void;
  onStage: StageFileHunks;
  project: string;
  sessionId: string;
}) {
  const selection: FileSelection = { path: file.path, project };
  const { dir, name } = splitPath(file.path);
  const tone = TONE_CLASS[STATUS_TONE[file.status]];
  const hunks = useReviewHunks(sessionId, project, file.path);

  return (
    <div className="border rounded mb-2">
      <button
        className="flex w-full items-baseline gap-2 truncate px-2 py-1 text-left text-xs transition-colors hover:bg-accent/50"
        onClick={() => onSelect({ path: file.path, project })}
        title={file.path}
        type="button"
      >
        <span className={cn("w-3 shrink-0 font-mono", tone)}>
          {STATUS_LABEL[file.status]}
        </span>
        <span className="min-w-0 flex-1 truncate">
          {dir ? <span className="text-muted-foreground">{dir}</span> : null}
          <span>{name}</span>
        </span>
      </button>

      <div className="pl-1 border-t">
        {hunks.isPending ? (
          <div className="flex justify-center py-3">
            <Spinner />
          </div>
        ) : hunks.data ? (
          <ReviewHunkList
            busy={busy}
            currentHunk={currentHunk}
            onReveal={onReveal}
            onStage={(stageHunks, direction) =>
              onStage(selection, stageHunks, direction)
            }
            onlyShowStaged
            staged={hunks.data.staged}
            unstaged={null}
            untracked={false}
          />
        ) : (
          <p className="px-2 py-2 text-[11px] text-muted-foreground">
            Unable to read this file&rsquo;s hunks.
          </p>
        )}
      </div>
    </div>
  );
}

export function ReviewStagedFiles({
  busy,
  files,
  onReveal,
  onSelect,
  onStage,
  position = null,
  project,
  sessionId,
}: {
  busy: boolean;
  files: readonly ChangedFile[];
  onReveal: (line: number) => void;
  onSelect: (selection: FileSelection) => void;
  onStage: StageFileHunks;
  /**
   * Where the keyboard cursor is, across every project. Narrowed per row
   * rather than pre-narrowed by the caller, since this list only knows its
   * own rows.
   */
  position?: HunkCursorPosition | null;
  project: string;
  sessionId: string;
}) {
  const staged = files.filter((file) => file.staged);

  if (staged.length === 0) return null;

  return (
    <div className="flex flex-col pb-2">
      <p className="pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Staged
      </p>

      <div className="flex flex-col">
        {staged.map((file) => (
          <StagedFileRow
            busy={busy}
            currentHunk={
              position?.slot &&
              sameFile(position.file, { path: file.path, project })
                ? position.slot
                : null
            }
            file={file}
            key={`${project}/${file.path}`}
            onReveal={onReveal}
            onSelect={onSelect}
            onStage={onStage}
            project={project}
            sessionId={sessionId}
          />
        ))}
      </div>
    </div>
  );
}
