"use client";

import { ArrowDown, ArrowUp, GitBranch } from "lucide-react";

import { useGitStatus } from "@/hooks/use-git-status";
import { describeGitStatus } from "@/lib/git-status-display";

/**
 * Branch and divergence for the session's project, shown in the prompt
 * toolbar.
 *
 * Renders nothing at all when there is nothing to say — no session, no project
 * attached, or a directory that is not a repository. An empty slot reads
 * better here than a placeholder next to the model picker.
 */
export function GitStatusBadge({ sessionId }: { sessionId?: string }) {
  const { data } = useGitStatus(sessionId);
  const label = describeGitStatus(data);

  if (!label) return null;

  return (
    <span
      className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground"
      title={label.title}
    >
      <GitBranch className="size-3.5 shrink-0" />
      <span className="max-w-40 truncate font-mono">{label.ref}</span>
      {label.ahead !== null && (
        <span className="flex items-center tabular-nums" aria-label={`${label.ahead} ahead`}>
          <ArrowUp className="size-3" />
          {label.ahead}
        </span>
      )}
      {label.behind !== null && (
        <span className="flex items-center tabular-nums" aria-label={`${label.behind} behind`}>
          <ArrowDown className="size-3" />
          {label.behind}
        </span>
      )}
    </span>
  );
}
