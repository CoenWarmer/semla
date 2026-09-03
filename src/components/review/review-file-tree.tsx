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

import { SearchIcon } from "lucide-react";
import { useState } from "react";

import { useFileSearch } from "@/components/session-file-search";
import {
  SessionFileTree,
  useSessionFiles,
  type FileEntry,
  type FileTreeMark,
} from "@/components/session-file-tree";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import type { ProjectReview } from "@/lib/review-types";
import { cn } from "@/lib/utils";

import {
  splitPath,
  STATUS_LABEL,
  STATUS_TONE,
  TONE_CLASS,
} from "./review-file-display";
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

/**
 * Ranked matches, as rows in the same visual language as the bucket.
 *
 * A flat list rather than a pruned tree. Filtering a tree in place means
 * deciding what to do with a directory whose name matches but whose children
 * do not, and every answer to that is surprising; a ranked list answers the
 * question the operator actually asked, which is "where is the file called
 * roughly this".
 */
function FilterResults({
  index,
  onSelectPath,
  paths,
  pending,
  prefix,
  selectedPath,
}: {
  index: ChangeIndex;
  onSelectPath: (path: string) => void;
  paths: readonly string[];
  pending: boolean;
  prefix: string;
  selectedPath: string | null;
}) {
  if (pending && paths.length === 0) {
    return (
      <div className="flex justify-center py-3">
        <Spinner className="size-3" />
      </div>
    );
  }

  if (paths.length === 0) {
    return (
      <p className="px-2 py-2 text-[11px] text-muted-foreground">
        No files match.
      </p>
    );
  }

  return (
    <div className="flex flex-col">
      {paths.map((full) => {
        const relative = full.slice(prefix.length);
        const { dir, name } = splitPath(relative);
        const status = index.files.get(full);

        return (
          <button
            className={cn(
              "flex w-full items-baseline gap-2 rounded px-2 py-1 text-left text-xs transition-colors",
              selectedPath === relative
                ? "bg-accent text-accent-foreground"
                : "hover:bg-accent/50",
            )}
            key={full}
            onClick={() => onSelectPath(relative)}
            title={relative}
            type="button"
          >
            <span className="min-w-0 flex-1 truncate">
              <span>{name}</span>
              {dir ? (
                <span className="pl-1.5 text-muted-foreground">{dir}</span>
              ) : null}
            </span>

            {status ? (
              <span
                className={cn(
                  "shrink-0 font-mono text-[10px]",
                  TONE_CLASS[STATUS_TONE[status]],
                )}
              >
                {STATUS_LABEL[status]}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
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
  const [query, setQuery] = useState("");
  // Debounced so a sweep of the project is not started on every keystroke.
  const debounced = useDebouncedValue(query.trim(), 150);

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

  const prefix = `${project.path}/`;
  const search = useFileSearch(sessionId, debounced, "project");
  // The route searches every project the session is linked to; this tree shows
  // one, and results from a repository that is not on screen would be rows the
  // operator cannot place.
  const matches = (search.data?.matches ?? [])
    .map((match) => match.path)
    .filter((path) => path.startsWith(prefix));

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

  /**
   * The body only. The filter box above it is rendered unconditionally: a
   * search that is available except while the directory listing loads, or
   * except when it failed, is a search the operator learns not to rely on —
   * and the two do not even depend on each other.
   */
  const body = debounced ? (
    <FilterResults
      index={index}
      onSelectPath={onSelectPath}
      paths={matches}
      pending={search.isFetching}
      prefix={prefix}
      selectedPath={selectedPath}
    />
  ) : root.isPending ? (
    <div className="flex justify-center py-3">
      <Spinner className="size-3" />
    </div>
  ) : root.isError ? (
    <p className="px-2 py-2 text-[11px] text-muted-foreground">
      Unable to read {project.name}.
    </p>
  ) : (
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

  return (
    <div className="flex min-h-0 flex-col">
      <div className="relative px-2 pb-1">
        <SearchIcon className="pointer-events-none absolute left-4 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
        <Input
          aria-label="Filter files"
          className="h-7 pl-7 text-xs"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            // Escape clears the filter before it closes the panel. Without
            // this the panel's own document-level handler takes it and the
            // operator loses the whole review to a keystroke meant for a
            // three-character query.
            if (event.key === "Escape" && query !== "") {
              event.stopPropagation();
              setQuery("");
            }
          }}
          placeholder="Filter files"
          value={query}
        />
      </div>

      {body}
    </div>
  );
}
