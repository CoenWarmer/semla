"use client";

import { XIcon } from "lucide-react";
import { useState } from "react";

import { GitStatusBadge } from "@/components/git-status-badge";
import { Spinner } from "@/components/ui/spinner";
import {
  useSessionProjectMutation,
  useSessionProjects,
} from "@/hooks/use-session-projects";

/** Compact, absolute date — a provenance record, not a relative "2h ago". */
const attachedOn = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
};

/**
 * The projects a session relates to: the one it is anchored on, and the ones it
 * has touched.
 *
 * These are two different kinds of thing and are shown as two, because the
 * decision that they cannot be edited the same way would otherwise read as a
 * bug. The anchor is configuration — chosen, and changeable. The rest is a
 * record of where the session has written, and a link the agent earned has no
 * remove control at all rather than one that fails.
 */
export function SessionProjectsPanel({ sessionId }: { sessionId: string }) {
  const { data: links, isLoading } = useSessionProjects(sessionId);
  const mutate = useSessionProjectMutation(sessionId);
  const [error, setError] = useState<string | null>(null);

  const change = (next: Parameters<typeof mutate.mutate>[0]) => {
    setError(null);
    mutate.mutate(next, { onError: (e) => setError(e.message) });
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 px-6 py-3 text-xs text-muted-foreground">
        <Spinner className="size-3" /> Loading projects…
      </div>
    );
  }

  const anchor = links?.find((link) => link.isPrimary) ?? null;
  const others = links?.filter((link) => !link.isPrimary) ?? [];

  return (
    <div className="shrink-0 space-y-2 border-b px-6 py-3">
      {/* Adding a project lives on the header's plus button, beside the badges
          it affects. Repeating it here would be a second place to look for the
          same action. */}
      <p className="text-xs font-medium text-muted-foreground">Projects</p>

      {!anchor && others.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No projects yet. One is attached automatically the first time the agent
          changes a file.
        </p>
      )}

      {anchor && (
        <div className="flex items-center gap-2">
          <GitStatusBadge
            showProjectName
            target={{ kind: "session", path: anchor.path, sessionId }}
          />
        </div>
      )}

      {others.length > 0 && (
        <div className="space-y-1 pt-1">
          {/* Named for what it is — a record of where this session has been,
              not a list of settings. */}
          <p className="text-[11px] text-muted-foreground/70">Also touched</p>
          {others.map((link) => (
            <div className="flex items-center gap-2 text-xs" key={link.path}>
              <span className="truncate font-medium">{link.path}</span>
              {attachedOn(link.firstAttachedAt) && (
                <span className="shrink-0 text-muted-foreground/70">
                  {attachedOn(link.firstAttachedAt)}
                </span>
              )}
              <button
                className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
                disabled={mutate.isPending}
                onClick={() => change({ kind: "anchor", path: link.path })}
                type="button"
              >
                Make anchor
              </button>
              {/* Only what the user attached can be taken back. A link the
                  agent earned by writing there is part of the record. */}
              {link.origin === "explicit" && (
                <button
                  aria-label={`Remove ${link.path}`}
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                  disabled={mutate.isPending}
                  onClick={() => change({ kind: "detach", path: link.path })}
                  type="button"
                >
                  <XIcon className="size-3" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  );
}
