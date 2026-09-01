"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { GitStatusBadge } from "@/components/git-status-badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import type { ProjectLink } from "@/lib/pi/session-project-links";
import { SESSION_STATUS_KEY } from "@/lib/session-status";
import type { WorkspaceProject } from "@/lib/pi/workspace";

const projectsKey = (sessionId: string) => ["session-projects", sessionId];

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
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);

  const { data: links, isLoading } = useQuery<ProjectLink[]>({
    queryKey: projectsKey(sessionId),
    queryFn: async () => {
      const res = await fetch(`/api/sessions/${sessionId}/projects`);
      if (!res.ok) throw new Error("Unable to load projects");
      return (await res.json()).projects as ProjectLink[];
    },
  });

  // Only fetched once the picker opens: this panel mounts with the sheet, and
  // the workspace listing is a filesystem sweep nobody has asked to see yet.
  const { data: workspace } = useQuery<WorkspaceProject[]>({
    enabled: adding,
    queryKey: ["workspace-projects"],
    queryFn: async () => {
      const res = await fetch("/api/projects");
      if (!res.ok) throw new Error("Unable to load workspace projects");
      return res.json() as Promise<WorkspaceProject[]>;
    },
  });

  const [error, setError] = useState<string | null>(null);

  const mutate = useMutation({
    mutationFn: async (
      change:
        | { kind: "attach"; path: string }
        | { kind: "anchor"; path: string }
        | { kind: "detach"; path: string },
    ) => {
      const base = `/api/sessions/${sessionId}/projects`;
      const res =
        change.kind === "detach"
          ? await fetch(`${base}?path=${encodeURIComponent(change.path)}`, {
              method: "DELETE",
            })
          : await fetch(base, {
              body: JSON.stringify({ path: change.path }),
              headers: { "Content-Type": "application/json" },
              method: change.kind === "attach" ? "POST" : "PATCH",
            });

      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? "That did not work.");
      return body.projects as ProjectLink[];
    },
    onMutate: () => setError(null),
    onError: (e: Error) => setError(e.message),
    onSuccess: (projects) => {
      queryClient.setQueryData(projectsKey(sessionId), projects);
      // The header badges and the sidebar chips both read the status poll, and
      // the file tree's roots come from the files listing.
      void queryClient.invalidateQueries({ queryKey: SESSION_STATUS_KEY });
      void queryClient.invalidateQueries({ queryKey: ["session-files", sessionId] });
      void queryClient.invalidateQueries({ queryKey: ["git-status"] });
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 px-6 py-3 text-xs text-muted-foreground">
        <Spinner className="size-3" /> Loading projects…
      </div>
    );
  }

  const anchor = links?.find((link) => link.isPrimary) ?? null;
  const others = links?.filter((link) => !link.isPrimary) ?? [];
  const linked = new Set(links?.map((link) => link.path));
  const attachable = (workspace ?? []).filter((p) => !linked.has(p.name));

  return (
    <div className="shrink-0 space-y-2 border-b px-6 py-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground">Projects</p>
        <Popover onOpenChange={setAdding} open={adding}>
          <PopoverTrigger
            render={
              <Button className="h-6 gap-1 px-2 text-xs" size="sm" variant="ghost" />
            }
          >
            <PlusIcon className="size-3" />
            Add
          </PopoverTrigger>
          <PopoverContent align="end" className="w-64 p-0">
            <Command>
              <CommandInput placeholder="Search projects…" />
              <CommandList>
                <CommandEmpty>No projects left to add.</CommandEmpty>
                <CommandGroup>
                  {attachable.map((project) => (
                    <CommandItem
                      key={project.path}
                      onSelect={() => {
                        setAdding(false);
                        mutate.mutate({ kind: "attach", path: project.name });
                      }}
                      value={project.name}
                    >
                      {project.name}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>

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
                onClick={() => mutate.mutate({ kind: "anchor", path: link.path })}
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
                  onClick={() => mutate.mutate({ kind: "detach", path: link.path })}
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
