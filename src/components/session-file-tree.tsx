"use client";

import { useQuery } from "@tanstack/react-query";

import {
  FileTree,
  FileTreeFile,
  FileTreeFolder,
} from "@/components/ai-elements/file-tree";
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
 * One entry in the tree, fetching its children only once it is expanded.
 *
 * Lazy by directory rather than depth-limited: the workspace root holds every
 * repository on the machine, and eagerly reading even two levels of that is a
 * lot of filesystem for a panel most of which will never be looked at.
 */
function FileTreeNode({
  entry,
  sessionId,
  expandedPaths,
}: {
  entry: FileEntry;
  sessionId: string;
  expandedPaths: Set<string>;
}) {
  const isExpanded = expandedPaths.has(entry.path);
  const childQuery = useQuery({
    enabled: entry.type === "directory" && isExpanded,
    queryKey: filesQueryKey(sessionId, entry.path),
    queryFn: () => fetchDirectory(sessionId, entry.path),
  });

  if (entry.type !== "directory") {
    return <FileTreeFile name={entry.name} path={entry.path} />;
  }

  return (
    <FileTreeFolder name={entry.name} path={entry.path}>
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
          sessionId={sessionId}
        />
      ))}
    </FileTreeFolder>
  );
}

export function SessionFileTree({
  entries,
  expandedPaths,
  onExpandedChange,
  onSelect,
  selectedPath,
  sessionId,
}: {
  entries: FileEntry[];
  expandedPaths: Set<string>;
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
          sessionId={sessionId}
        />
      ))}
    </FileTree>
  );
}
