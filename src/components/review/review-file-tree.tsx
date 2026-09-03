"use client";

/**
 * The whole project, under the bucket of changed files.
 *
 * The bucket answers "what changed" and cannot answer "where". Eight paths in
 * a flat list say nothing about the shape of the project they came from —
 * whether the agent worked in one corner or scattered edits across four
 * packages — and that shape is often the first thing wrong with a change.
 *
 * So the tree is not decoration. It opens on the directories the turn touched
 * and marks each changed file with git's own letter, which makes the answer to
 * "where" readable at a glance; and it stays browsable, so the file that was
 * *not* changed but should have been can be opened and read too.
 */

import { useState } from "react";

import {
  SessionFileTree,
  useSessionFiles,
  type FileEntry,
  type FileTreeMark,
} from "@/components/session-file-tree";
import { Spinner } from "@/components/ui/spinner";
import type { ProjectReview } from "@/lib/review-types";

import { STATUS_LABEL, STATUS_TONE, TONE_CLASS } from "./review-file-display";
import {
  directoriesToExpand,
  indexChanges,
  type ChangeIndex,
} from "./review-tree-marks";

/**
 * How a row stands out.
 *
 * Files only. `FileTreeFolder` renders its row inside the element it exposes,
 * so a class on a folder would tint its whole subtree rather than its own
 * line — the initial expansion is what surfaces a changed directory instead.
 */
function markFor(index: ChangeIndex, entry: FileEntry): FileTreeMark | null {
  if (entry.type === "directory") return null;

  const status = index.files.get(entry.path);
  if (!status) return null;

  return {
    badge: STATUS_LABEL[status],
    badgeClassName: TONE_CLASS[STATUS_TONE[status]],
    className: "bg-accent/30",
  };
}

export function ReviewFileTree({
  onSelectPath,
  project,
  projects,
  selectedPath,
  sessionId,
}: {
  /** Project-relative path of the file chosen. */
  onSelectPath: (path: string) => void;
  project: ProjectReview;
  /** Every project, so the index covers a session working in several. */
  projects: readonly ProjectReview[];
  /** Project-relative path of the open file, for the selected row. */
  selectedPath: string | null;
  sessionId: string;
}) {
  const index = indexChanges(projects);

  /**
   * Expanded once, from the turn's own changes.
   *
   * A lazy initialiser rather than an effect: this repository treats
   * `react/set-state-in-effect` as an error, and re-deriving the set on every
   * refetch would spring folders back open after the operator collapsed them.
   * The panel remounts this component when the project changes, so switching
   * repositories does re-expand.
   */
  const [expanded, setExpanded] = useState(() =>
    directoriesToExpand(index, project.path),
  );

  const root = useSessionFiles(sessionId, project.path);

  if (root.isPending) {
    return (
      <div className="flex justify-center py-3">
        <Spinner className="size-3" />
      </div>
    );
  }

  if (root.isError) {
    return (
      <p className="px-2 py-2 text-[11px] text-muted-foreground">
        Unable to read {project.name}.
      </p>
    );
  }

  const prefix = `${project.path}/`;

  /**
   * `node_modules` is left out of the review tree.
   *
   * Not a general opinion about the directory — the Files panel still shows
   * it. Here it is noise in the one thing this tree is for: it is gitignored,
   * so nothing in it can ever appear in the bucket above, it tells the
   * operator nothing about the shape of the change, and one stray click
   * expands a fetch of several thousand entries.
   */
  const entries = (root.data?.files ?? []).filter(
    (entry) => entry.name !== "node_modules",
  );

  return (
    <SessionFileTree
      entries={entries}
      expandedPaths={expanded}
      mark={(entry) => markFor(index, entry)}
      onExpandedChange={setExpanded}
      // Folders arrive here as well and are only toggling; the file case is
      // handled by onSelectFile so nothing tries to read a directory.
      onSelect={() => {}}
      onSelectFile={(entry) =>
        onSelectPath(
          entry.path.startsWith(prefix)
            ? entry.path.slice(prefix.length)
            : entry.path,
        )
      }
      selectedPath={selectedPath ? `${prefix}${selectedPath}` : null}
      sessionId={sessionId}
    />
  );
}
