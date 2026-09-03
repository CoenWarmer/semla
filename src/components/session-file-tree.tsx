"use client";

import { useQuery } from "@tanstack/react-query";

import { FileIcon } from "lucide-react";

import {
  FileTree,
  FileTreeFile,
  FileTreeFolder,
  FileTreeIcon,
  FileTreeName,
} from "@/components/ai-elements/file-tree";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";
import type { FileEntry } from "@/lib/pi/file-browser";

export type { FileEntry };

/** Every directory listing cached for a session, whatever its path. */
export const filesQueryPrefix = (sessionId: string) =>
  ["session-files", sessionId] as const;

export const filesQueryKey = (sessionId: string, dirPath: string) =>
  [...filesQueryPrefix(sessionId), dirPath] as const;

export type DirectoryListing = {
  files: FileEntry[];
  root: string;
  /** The session's projects, workspace-relative and anchor first. */
  basePaths: string[];
  path: string;
};

export async function fetchDirectory(
  sessionId: string,
  dirPath: string,
): Promise<DirectoryListing> {
  const params = new URLSearchParams({ path: dirPath });
  const res = await fetch(`/api/sessions/${sessionId}/files?${params}`);
  if (!res.ok) throw new Error("Unable to list files");
  return res.json();
}

export function useSessionFiles(sessionId: string, dirPath: string) {
  return useQuery({
    queryKey: filesQueryKey(sessionId, dirPath),
    queryFn: () => fetchDirectory(sessionId, dirPath),
  });
}

/**
 * How an entry should stand out, or null for the plain row.
 *
 * Added for the review panel, which needs the tree to say *where* a turn's
 * changes are — a flat list of paths gives no sense of the shape of the
 * project they came from. Generic on purpose: the tree is told which rows to
 * mark and how, and knows nothing about git.
 */
export type FileTreeMark = {
  /** Extra classes for the row. */
  className?: string;
  /** A short marker at the end of a file row, such as a status letter. */
  badge?: string;
  /** Classes for that marker. */
  badgeClassName?: string;
};

export type MarkEntry = (entry: FileEntry) => FileTreeMark | null;

/**
 * Called when a *file* row is chosen, as opposed to a folder being toggled.
 *
 * `FileTree`'s own `onSelect` fires for both, and a caller that opens whatever
 * it is handed will try to read a directory as a file. Wired through the row's
 * own click handler, which overrides the context one because the primitive
 * spreads its props last.
 */
export type SelectFile = (entry: FileEntry) => void;

/**
 * One entry in the tree, fetching its children only once it is expanded.
 *
 * Lazy by directory rather than depth-limited: the workspace root holds every
 * repository on the machine, and eagerly reading even two levels of that is a
 * lot of filesystem for a panel most of which will never be looked at.
 */
function FileTreeNode({
  entry,
  mark,
  onSelectFile,
  sessionId,
  expandedPaths,
}: {
  entry: FileEntry;
  mark?: MarkEntry;
  onSelectFile?: SelectFile;
  sessionId: string;
  expandedPaths: Set<string>;
}) {
  const isExpanded = expandedPaths.has(entry.path);
  const marked = mark?.(entry) ?? null;
  // Spread conditionally: an explicit `onClick: undefined` would override the
  // primitive's own handler with nothing and make the row inert.
  const fileProps = onSelectFile
    ? { onClick: () => onSelectFile(entry) }
    : {};
  const childQuery = useQuery({
    enabled: entry.type === "directory" && isExpanded,
    queryKey: filesQueryKey(sessionId, entry.path),
    queryFn: () => fetchDirectory(sessionId, entry.path),
  });

  if (entry.type !== "directory") {
    // A marked file renders its own row, because `children` replaces the
    // default content and that is the only way to get a badge in beside the
    // name without changing the primitive.
    if (!marked) {
      return (
        <FileTreeFile name={entry.name} path={entry.path} {...fileProps} />
      );
    }

    return (
      <FileTreeFile
        className={marked.className}
        name={entry.name}
        path={entry.path}
        {...fileProps}
      >
        <span className="size-4 shrink-0" />
        <FileTreeIcon>
          <FileIcon className="size-4 text-muted-foreground" />
        </FileTreeIcon>
        <FileTreeName>{entry.name}</FileTreeName>
        {marked.badge ? (
          <span
            className={cn(
              "ml-auto shrink-0 pl-1 font-mono text-[10px]",
              marked.badgeClassName,
            )}
          >
            {marked.badge}
          </span>
        ) : null}
      </FileTreeFile>
    );
  }

  return (
    <FileTreeFolder
      className={marked?.className}
      name={entry.name}
      path={entry.path}
    >
      {childQuery.isLoading && (
        <div className="py-1 pl-4">
          <Spinner className="size-3" />
        </div>
      )}
      {childQuery.data?.files.map((child) => (
        <FileTreeNode
          key={child.path}
          entry={child}
          expandedPaths={expandedPaths}
          mark={mark}
          onSelectFile={onSelectFile}
          sessionId={sessionId}
        />
      ))}
    </FileTreeFolder>
  );
}

export function SessionFileTree({
  entries,
  expandedPaths,
  mark,
  onExpandedChange,
  onSelect,
  onSelectFile,
  selectedPath,
  sessionId,
}: {
  entries: FileEntry[];
  expandedPaths: Set<string>;
  /** Optional per-row decoration. Omit it and every row is plain. */
  mark?: MarkEntry;
  /** Files only. Folders still toggle through `onSelect`. */
  onSelectFile?: SelectFile;
  onExpandedChange: (expanded: Set<string>) => void;
  onSelect: (path: string) => void;
  selectedPath: string | null;
  sessionId: string;
}) {
  return (
    <FileTree
      className="border-none bg-transparent"
      expanded={expandedPaths}
      onExpandedChange={onExpandedChange}
      onSelect={onSelect}
      selectedPath={selectedPath ?? undefined}
    >
      {entries.map((entry) => (
        <FileTreeNode
          key={entry.path}
          entry={entry}
          expandedPaths={expandedPaths}
          mark={mark}
          onSelectFile={onSelectFile}
          sessionId={sessionId}
        />
      ))}
    </FileTree>
  );
}
