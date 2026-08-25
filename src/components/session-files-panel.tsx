"use client";

import {
  FileTree,
  FileTreeFile,
  FileTreeFolder,
} from "@/components/ai-elements/file-tree";
import { Spinner } from "@/components/ui/spinner";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

type FileEntry = {
  name: string;
  path: string;
  type: "file" | "directory";
};

function useSessionFiles(sessionId: string, dirPath: string) {
  return useQuery({
    queryKey: ["session-files", sessionId, dirPath],
    queryFn: async () => {
      const params = new URLSearchParams({ path: dirPath });
      const res = await fetch(`/api/sessions/${sessionId}/files?${params}`);
      if (!res.ok) throw new Error("Unable to list files");
      return res.json() as Promise<{ files: FileEntry[]; root: string }>;
    },
  });
}

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

function FileTreeNode({
  entry,
  sessionId,
  expandedPaths,
  onToggle,
  onSelect,
  selectedPath,
}: {
  entry: FileEntry;
  sessionId: string;
  expandedPaths: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  selectedPath: string | null;
}) {
  const isExpanded = expandedPaths.has(entry.path);
  const childQuery = useQuery({
    enabled: entry.type === "directory" && isExpanded,
    queryKey: ["session-files", sessionId, entry.path],
    queryFn: async () => {
      const params = new URLSearchParams({ path: entry.path });
      const res = await fetch(`/api/sessions/${sessionId}/files?${params}`);
      if (!res.ok) throw new Error("Unable to list files");
      return res.json() as Promise<{ files: FileEntry[]; root: string }>;
    },
  });

  if (entry.type === "directory") {
    return (
      <FileTreeFolder
        key={entry.path}
        name={entry.name}
        path={entry.path}
      >
        {childQuery.isLoading && (
          <div className="pl-4 py-1">
            <Spinner className="size-3" />
          </div>
        )}
        {childQuery.data?.files.map((child) => (
          <FileTreeNode
            key={child.path}
            entry={child}
            sessionId={sessionId}
            expandedPaths={expandedPaths}
            onToggle={onToggle}
            onSelect={onSelect}
            selectedPath={selectedPath}
          />
        ))}
      </FileTreeFolder>
    );
  }

  return (
    <FileTreeFile
      key={entry.path}
      name={entry.name}
      path={entry.path}
    />
  );
}

export function SessionFilesPanel({ sessionId }: { sessionId: string }) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());

  const rootQuery = useSessionFiles(sessionId, "");
  const contentQuery = useFileContent(sessionId, selectedPath);

  const handleToggle = (path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const handleSelect = (path: string) => {
    const entry = rootQuery.data?.files.find((f) => f.path === path);
    if (!entry || entry.type === "directory") {
      handleToggle(path);
    } else {
      setSelectedPath(path);
    }
  };

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      <div className="w-64 shrink-0 border-r overflow-y-auto p-2">
        {rootQuery.isLoading ? (
          <div className="flex items-center justify-center p-4">
            <Spinner className="size-4" />
          </div>
        ) : rootQuery.error ? (
          <p className="p-4 text-sm text-destructive">Unable to list files</p>
        ) : (
          <FileTree
            className="border-none bg-transparent"
            expanded={expandedPaths}
            selectedPath={selectedPath ?? undefined}
            onSelect={handleSelect}
            onExpandedChange={setExpandedPaths}
          >
            {rootQuery.data?.files.map((entry) => (
              <FileTreeNode
                key={entry.path}
                entry={entry}
                sessionId={sessionId}
                expandedPaths={expandedPaths}
                onToggle={handleToggle}
                onSelect={handleSelect}
                selectedPath={selectedPath}
              />
            ))}
          </FileTree>
        )}
      </div>

      <div className="flex-1 min-w-0 overflow-auto">
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
          <pre className="p-4 text-xs font-mono leading-relaxed whitespace-pre-wrap break-words">
            {contentQuery.data?.content}
          </pre>
        )}
      </div>
    </div>
  );
}
