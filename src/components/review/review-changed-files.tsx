"use client";

/**
 * The bucket of changed files, above the tree.
 *
 * Above rather than inside it, deliberately: what a turn changed is a short
 * list the operator wants whole, and burying eight files inside a tree of four
 * thousand is what this panel exists to avoid. The tree underneath is for
 * looking at everything else — the file that was *not* changed but should have
 * been is a review finding too.
 */

import { cn } from "@/lib/utils";
import type { ChangedFile, ProjectReview } from "@/lib/review-types";

import {
  renameLabel,
  splitPath,
  STATUS_LABEL,
  STATUS_TONE,
  TONE_CLASS,
} from "./review-file-display";

export interface FileSelection {
  project: string;
  path: string;
}

function FileRow({
  file,
  onSelect,
  selected,
}: {
  file: ChangedFile;
  onSelect: () => void;
  selected: boolean;
}) {
  const { dir } = splitPath(file.path);
  const tone = TONE_CLASS[STATUS_TONE[file.status]];

  return (
    <button
      className={cn(
        "flex w-full items-baseline gap-2 rounded px-2 py-1 text-left text-xs transition-colors",
        selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
      )}
      onClick={onSelect}
      title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
      type="button"
    >
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
  );
}

export function ReviewChangedFiles({
  onSelect,
  projects,
  selected,
}: {
  onSelect: (selection: FileSelection) => void;
  projects: readonly ProjectReview[];
  selected: FileSelection | null;
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
                key={`${project.path}/${file.path}`}
                file={file}
                onSelect={() =>
                  onSelect({ path: file.path, project: project.path })
                }
                selected={
                  selected?.project === project.path &&
                  selected.path === file.path
                }
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
