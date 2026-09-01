"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SearchIcon } from "lucide-react";
import { useState } from "react";

import { SessionFileSearch } from "@/components/session-file-search";
import {
  filesQueryPrefix,
  SessionFileTree,
  useSessionFiles,
  type DirectoryListing,
  type FileEntry,
} from "@/components/session-file-tree";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useDebouncedValue } from "@/hooks/use-debounced-value";

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

/**
 * One project's tree, under a heading naming it.
 *
 * Its own query rather than a slice of a shared one: each root is a separate
 * directory listing, and `filesQueryKey` is already keyed by path, so several
 * roots coexist in the cache with no change to the query layer.
 */
function ProjectTree({
  expandedPaths,
  name,
  onExpandedChange,
  onSelect,
  rootPath,
  selectedPath,
  sessionId,
}: {
  expandedPaths: Set<string>;
  name: string;
  onExpandedChange: (paths: Set<string>) => void;
  onSelect: (path: string) => void;
  rootPath: string;
  selectedPath: string | null;
  sessionId: string;
}) {
  const query = useSessionFiles(sessionId, rootPath);

  return (
    <div>
      <p className="truncate px-1 pb-1 text-xs font-medium text-muted-foreground">
        {name}
      </p>
      {query.isLoading ? (
        <div className="flex items-center justify-center p-2">
          <Spinner className="size-4" />
        </div>
      ) : query.error ? (
        <p className="px-1 text-sm text-destructive">Unable to list files</p>
      ) : (
        <SessionFileTree
          entries={query.data?.files ?? []}
          expandedPaths={expandedPaths}
          onExpandedChange={onExpandedChange}
          onSelect={onSelect}
          selectedPath={selectedPath}
          sessionId={sessionId}
        />
      )}
    </div>
  );
}

export function SessionFilesPanel({ sessionId }: { sessionId: string }) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query.trim(), 200);

  const queryClient = useQueryClient();
  // An empty path means "wherever this session starts" — the server answers
  // with the anchor's directory, and tells us the whole set alongside it.
  const rootQuery = useSessionFiles(sessionId, "");
  const contentQuery = useFileContent(sessionId, selectedPath);

  const basePaths = rootQuery.data?.basePaths ?? [];
  const projectName = lastSegment(basePaths[0] ?? null);

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
        <div className="shrink-0 space-y-2 border-b p-2">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Filter filenames"
              className="h-8 pl-9 text-sm"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter filenames…"
              type="search"
              value={query}
            />
          </div>
          {basePaths.length === 1 && !debouncedQuery && (
            // One project needs no heading inside the tree, so it is named
            // here. Several are named by their own root rows instead.
            <p className="truncate px-1 text-xs text-muted-foreground">
              {projectName}
            </p>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {debouncedQuery ? (
            <SessionFileSearch
              hasProject={basePaths.length > 0}
              onSelect={setSelectedPath}
              projectName={
                basePaths.length > 1 ? `${basePaths.length} projects` : projectName
              }
              query={debouncedQuery}
              selectedPath={selectedPath}
              sessionId={sessionId}
            />
          ) : rootQuery.isLoading ? (
            <div className="flex items-center justify-center p-4">
              <Spinner className="size-4" />
            </div>
          ) : rootQuery.error ? (
            <p className="p-4 text-sm text-destructive">Unable to list files</p>
          ) : basePaths.length > 1 ? (
            // One tree per project, each rooted at its own directory. A session
            // working in three repositories should show all three rather than
            // hide two of them behind a search.
            <div className="space-y-3">
              {basePaths.map((basePath) => (
                <ProjectTree
                  expandedPaths={expandedPaths}
                  key={basePath}
                  name={lastSegment(basePath) ?? basePath}
                  onExpandedChange={setExpandedPaths}
                  onSelect={handleSelect}
                  rootPath={basePath}
                  selectedPath={selectedPath}
                  sessionId={sessionId}
                />
              ))}
            </div>
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
