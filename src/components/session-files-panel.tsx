"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  filesQueryPrefix,
  SessionFileTree,
  useSessionFiles,
  type DirectoryListing,
  type FileEntry,
} from "@/components/session-file-tree";
import { Spinner } from "@/components/ui/spinner";

function useFileContent(sessionId: string, filePath: string | null) {
  return useQuery({
    enabled: filePath !== null,
    queryKey: ["session-file-content", sessionId, filePath],
    queryFn: async () => {
      const params = new URLSearchParams({ path: filePath! });
      const res = await fetch(`/api/sessions/${sessionId}/files/content?${params}`);
      if (!res.ok) throw new Error("Unable to read file");
      return res.json() as Promise<{ content: string; path: string }>;
    },
  });
}

/** Last segment of a workspace-relative path — the project's own name. */
const lastSegment = (path: string | null) =>
  path ? (path.split("/").pop() ?? null) : null;

export function SessionFilesPanel({ sessionId }: { sessionId: string }) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());

  const queryClient = useQueryClient();
  // An empty path means "wherever this session starts" — the server answers
  // with the project directory when the session has one.
  const rootQuery = useSessionFiles(sessionId, "");
  const contentQuery = useFileContent(sessionId, selectedPath);

  const projectName = lastSegment(rootQuery.data?.basePath ?? null);

  /**
   * The tree reports a selection by path alone, so the entry's type is looked
   * up in the listing it came from. Those listings are already in the query
   * cache — every expanded directory is a cached fetch — which is both cheaper
   * than mirroring them into component state and correct at any depth. Matching
   * against the root listing alone, as this once did, meant clicking a nested
   * file toggled it as if it were a folder instead of opening it.
   */
  const findEntry = (path: string): FileEntry | null => {
    const listings = queryClient.getQueriesData<DirectoryListing>({
      queryKey: filesQueryPrefix(sessionId),
    });
    for (const [, listing] of listings) {
      const hit = listing?.files.find((file) => file.path === path);
      if (hit) return hit;
    }
    return null;
  };

  const toggle = (path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const handleSelect = (path: string) => {
    const entry = findEntry(path);
    if (entry && entry.type === "file") setSelectedPath(path);
    else toggle(path);
  };

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      <div className="flex w-72 shrink-0 flex-col overflow-hidden border-r">
        {projectName && (
          <p className="shrink-0 truncate border-b px-3 py-2 text-xs text-muted-foreground">
            {projectName}
          </p>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {rootQuery.isLoading ? (
            <div className="flex items-center justify-center p-4">
              <Spinner className="size-4" />
            </div>
          ) : rootQuery.error ? (
            <p className="p-4 text-sm text-destructive">Unable to list files</p>
          ) : (
            <SessionFileTree
              entries={rootQuery.data?.files ?? []}
              expandedPaths={expandedPaths}
              onExpandedChange={setExpandedPaths}
              onSelect={handleSelect}
              selectedPath={selectedPath}
              sessionId={sessionId}
            />
          )}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {selectedPath && (
          <p className="shrink-0 truncate border-b px-4 py-2 font-mono text-xs text-muted-foreground">
            {selectedPath}
          </p>
        )}
        <div className="min-h-0 flex-1 overflow-auto">
          {!selectedPath ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Select a file to view its contents
            </div>
          ) : contentQuery.isLoading ? (
            <div className="flex h-full items-center justify-center">
              <Spinner className="size-4" />
            </div>
          ) : contentQuery.error ? (
            <p className="p-4 text-sm text-destructive">Unable to read file</p>
          ) : (
            <pre className="p-4 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
              {contentQuery.data?.content}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
