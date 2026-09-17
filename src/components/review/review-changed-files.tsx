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

import { ChevronDownIcon, ChevronRightIcon, XIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { commitScope } from "@/lib/review/review-commit-scope";
import type {
  ChangedFile,
  ProjectReview,
  TurnCommit,
} from "@/lib/review/review-types";
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
import { ReviewStagedFiles } from "./review-staged-files";

export interface FileSelection {
  project: string;
  path: string;
}

/** Stage or unstage hunks of a specific file, identified rather than assumed. */
export type StageFileHunks = (
  file: FileSelection,
  hunks: number[],
  direction: "stage" | "unstage",
) => void;

/** The hunks of one expanded file, fetched only while it is open. */
function ExpandedHunks({
  busy,
  commitSha,
  onReveal,
  onStage,
  selection,
  sessionId,
}: {
  busy: boolean;
  /** Read this commit's diff instead of the working tree's. */
  commitSha: string | null;
  onReveal: (line: number) => void;
  onStage: StageFileHunks;
  selection: FileSelection;
  sessionId: string;
}) {
  const hunks = useReviewHunks(
    sessionId,
    selection.project,
    selection.path,
    commitSha,
  );

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

  // A commit's diff, with no staging controls: `staged` and `unstaged` come
  // back null from the route precisely because a commit has no index, and
  // `ReviewHunkList`'s groups are built from those two.
  if (commitSha) {
    return (
      <ReviewHunkList
        busy={busy}
        onReveal={onReveal}
        onStage={() => {}}
        readOnly
        staged={null}
        unstaged={hunks.data.full}
        untracked={false}
      />
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
      onStage={(hunks, direction) => onStage(selection, hunks, direction)}
      staged={hunks.data.staged}
      unstaged={hunks.data.unstaged}
      untracked={hunks.data.untracked}
    />
  );
}

export function FileRow({
  busy,
  commitSha = null,
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
  /** Show this commit's diff rather than the working tree's. */
  commitSha?: string | null;
  expanded: boolean;
  file: ChangedFile;
  onReveal: (line: number) => void;
  onStage: StageFileHunks;
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
        <div className="pl-1 border rounded mb-3">
          <ExpandedHunks
            busy={busy}
            commitSha={commitSha}
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

/**
 * "Changed files in semla", or "Changed files in #eafa5" with a way out.
 *
 * The close button is on the label rather than beside the commit nav because
 * the label is where the scope is *stated* — an operator who has scrolled the
 * sidebar and is wondering why a file they just edited is missing is looking
 * here, not at the dots above.
 */
function ScopeLabel({
  commit,
  onClear,
  projectName,
}: {
  commit: TurnCommit | null;
  onClear: () => void;
  projectName: string;
}) {
  if (!commit) {
    return (
      <p className="pb-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Changed files in {projectName}
      </p>
    );
  }

  return (
    <div className="flex items-center gap-1 pb-2">
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Changed files in{" "}
        <span className="font-mono normal-case text-foreground">
          {commit.shortSha}
        </span>
      </p>
      <button
        aria-label="Show uncommitted changes instead"
        className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        onClick={onClear}
        title={`Stop showing only ${commit.shortSha} — show uncommitted changes`}
        type="button"
      >
        <XIcon className="size-3" />
      </button>
    </div>
  );
}

export function ReviewChangedFiles({
  busy,
  expanded,
  onClearCommit,
  onReveal,
  onSelect,
  onStage,
  projects,
  selectedCommitSha,
  selected,
  sessionId,
}: {
  busy: boolean;
  /** The one file currently folded open, or null when none is. */
  expanded: FileSelection | null;
  /** Drop the commit selection, back to the working tree. */
  onClearCommit: () => void;
  onReveal: (line: number) => void;
  /**
   * Clicking a row both opens it in the editor and folds its hunks open —
   * one action, not two, so there is no separate "select" the operator has
   * to remember to also do.
   */
  onSelect: (selection: FileSelection) => void;
  onStage: StageFileHunks;
  projects: readonly ProjectReview[];
  /**
   * The commit the nav has selected, or null for the working tree. Applies to
   * every project listed: the nav draws the active project's commits, and a
   * sha is unique to one repository anyway.
   */
  selectedCommitSha: string | null;
  selected: FileSelection | null;
  sessionId: string;
}) {
  const scopes = projects
    .map((project) => ({
      project,
      scope: commitScope(project, selectedCommitSha),
    }))
    .filter(({ scope }) => scope.files.length > 0);

  if (scopes.length === 0) {
    return (
      <p className="px-2 py-3 text-xs text-muted-foreground">
        {selectedCommitSha
          ? "That commit changed nothing in this project."
          : "Nothing has changed in this session\u2019s projects."}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2 px-2">
      {scopes.map(({ project, scope }) => (
        <div key={project.path}>
          <ScopeLabel
            commit={scope.commit}
            onClear={onClearCommit}
            projectName={project.name}
          />

          {/* The staged bucket and the "to review" heading are both about the
              index, which a commit does not have. Showing them under a commit
              selection would mix the two things this feature exists to
              separate. */}
          {scope.commit ? null : (
            <>
              <ReviewStagedFiles
                busy={busy}
                files={scope.files}
                onReveal={onReveal}
                onSelect={onSelect}
                onStage={onStage}
                project={project.path}
                sessionId={sessionId}
              />
              <span className="text-[10px] uppercase font-medium text-muted-foreground">
                To review
              </span>
            </>
          )}

          <div className="flex flex-col">
            {/* A file entirely staged has nothing left to review here — it
                already has its own row in ReviewStagedFiles above, and a
                second row here with no unstaged hunks to show would just be
                an empty accordion. A commit's rows are never staged, so this
                filter passes all of them. */}
            {scope.files
              .filter((file) => file.unstaged || !file.staged)
              .map((file) => (
                <FileRow
                  busy={busy}
                  commitSha={scope.commit?.sha ?? null}
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

          {/* The cap applies to the working-tree read, not to a commit's own
              file list, so it is only true of the unscoped list. */}
          {!scope.commit && project.omitted > 0 ? (
            <p className="px-2 pt-1 text-[10px] text-muted-foreground">
              {project.omitted} more not listed
            </p>
          ) : null}
        </div>
      ))}
    </div>
  );
}
