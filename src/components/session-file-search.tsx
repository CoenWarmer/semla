"use client";

import { useQuery } from "@tanstack/react-query";
import { FileIcon } from "lucide-react";

import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type { FileMatch } from "@/lib/file-search";

type Scope = "project" | "workspace";

type SearchResponse = {
  complete: boolean;
  matches: FileMatch[];
  query: string;
  scope: Scope;
};

/**
 * One scope's matches, fetched independently of the other.
 *
 * Two queries rather than one is the whole point: the project's files are found
 * in a fraction of the time it takes to sweep every repository on the machine,
 * and a single request would make the fast answer wait for the slow one.
 */
function useFileSearch(sessionId: string, query: string, scope: Scope, enabled = true) {
  return useQuery({
    enabled: enabled && query.length > 0,
    queryKey: ["session-file-search", sessionId, scope, query],
    queryFn: async (): Promise<SearchResponse> => {
      const params = new URLSearchParams({ q: query, scope });
      const res = await fetch(`/api/sessions/${sessionId}/files/search?${params}`);
      if (!res.ok) throw new Error("Unable to search files");
      return res.json();
    },
    // Results for a given query do not change while the drawer is open, and
    // keeping the previous ones stops the list blanking on every keystroke.
    placeholderData: (previous) => previous,
    staleTime: 30_000,
  });
}

/** The directory part of a path, for the dim second line under a filename. */
const directoryOf = (path: string) => {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
};

function ResultRow({
  match,
  onSelect,
  selected,
}: {
  match: FileMatch;
  onSelect: (path: string) => void;
  selected: boolean;
}) {
  return (
    <button
      className={cn(
        "flex w-full min-w-0 items-center gap-2 rounded px-2 py-1 text-left transition-colors hover:bg-muted/50",
        selected && "bg-muted",
      )}
      onClick={() => onSelect(match.path)}
      title={match.path}
      type="button"
    >
      <FileIcon className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{match.name}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {directoryOf(match.path)}
        </span>
      </span>
    </button>
  );
}

/**
 * A labelled group of results, which reports its own progress.
 *
 * Each group carries its own spinner so a slow scope shows that it is still
 * working instead of looking like a scope that found nothing.
 */
function ResultGroup({
  label,
  matches,
  onSelect,
  partial,
  pending,
  selectedPath,
}: {
  label: string | null;
  matches: FileMatch[];
  onSelect: (path: string) => void;
  partial: boolean;
  pending: boolean;
  selectedPath: string | null;
}) {
  if (!pending && matches.length === 0) return null;

  return (
    <div className="mb-2">
      {label ? (
        <p className="flex items-center gap-2 px-2 py-1 text-xs font-medium text-muted-foreground">
          {label}
          {pending && <Spinner className="size-3" />}
        </p>
      ) : (
        // Unlabelled — a session with no project has a single, unheaded list,
        // which still needs somewhere to show that it is working.
        pending && (
          <div className="flex items-center justify-center p-4">
            <Spinner className="size-4" />
          </div>
        )
      )}
      {matches.map((match) => (
        <ResultRow
          key={match.path}
          match={match}
          onSelect={onSelect}
          selected={selectedPath === match.path}
        />
      ))}
      {partial && (
        <p className="px-2 py-1 text-xs text-muted-foreground">
          Too large to search fully — these are matches from the part scanned.
        </p>
      )}
    </div>
  );
}

/**
 * Filename matches for the current query, the session's project first.
 *
 * The two groups are labelled rather than merely ordered. Ranking that puts the
 * project on top is only trustworthy if it is visible — otherwise a match from
 * another repository, sitting third in an unbroken list, reads as a file in the
 * project you are working in.
 */
export function SessionFileSearch({
  hasProject,
  onSelect,
  projectName,
  query,
  selectedPath,
  sessionId,
}: {
  hasProject: boolean;
  onSelect: (path: string) => void;
  projectName: string | null;
  query: string;
  selectedPath: string | null;
  sessionId: string;
}) {
  const project = useFileSearch(sessionId, query, "project", hasProject);
  const workspace = useFileSearch(sessionId, query, "workspace");

  const projectMatches = hasProject ? (project.data?.matches ?? []) : [];
  const workspaceMatches = workspace.data?.matches ?? [];

  // A stale response from a previous query is worse than a spinner: it shows
  // matches for a word that is no longer in the box.
  const projectPending = hasProject && project.data?.query !== query;
  const workspacePending = workspace.data?.query !== query;

  if (project.error && workspace.error) {
    return <p className="p-4 text-sm text-destructive">Unable to search files</p>;
  }

  const settled = !projectPending && !workspacePending;
  if (settled && projectMatches.length === 0 && workspaceMatches.length === 0) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        No filenames match “{query}”.
      </p>
    );
  }

  return (
    <div className="font-mono text-sm">
      {hasProject && (
        <ResultGroup
          label={projectName ? `In ${projectName}` : "In this project"}
          matches={projectPending ? [] : projectMatches}
          onSelect={onSelect}
          partial={project.data?.complete === false}
          pending={projectPending}
          selectedPath={selectedPath}
        />
      )}
      <ResultGroup
        label={hasProject ? "Elsewhere in the workspace" : null}
        matches={workspacePending ? [] : workspaceMatches}
        onSelect={onSelect}
        partial={workspace.data?.complete === false}
        pending={workspacePending}
        selectedPath={selectedPath}
      />
    </div>
  );
}
