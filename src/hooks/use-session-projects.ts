"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { toolsQueryKey } from "@/hooks/use-tools";
import type { ProjectLink } from "@/lib/pi/session-project-links";
import { SESSION_STATUS_KEY } from "@/lib/session-status";

export const sessionProjectsKey = (sessionId: string) =>
  ["session-projects", sessionId] as const;

/** Every project a session relates to, anchor first. */
export function useSessionProjects(sessionId: string) {
  return useQuery<ProjectLink[]>({
    queryKey: sessionProjectsKey(sessionId),
    queryFn: async () => {
      const res = await fetch(`/api/sessions/${sessionId}/projects`);
      if (!res.ok) throw new Error("Unable to load projects");
      return (await res.json()).projects as ProjectLink[];
    },
  });
}

export type ProjectChange =
  | { kind: "attach"; path: string }
  | { kind: "anchor"; path: string }
  | { kind: "detach"; path: string };

/**
 * Everything that has to re-read when a session's project links change.
 *
 * The list is the interesting part, so it is one list rather than two that
 * would drift: the badges and the sidebar chips come from the status poll, the
 * file tree's roots from the files listing, and the branch state from its own
 * query.
 *
 * The tool list is here because which extensions a session loads depends on
 * whether it has a project at all — see `requiresProjectAnchor`. Attaching the
 * first one gains it the code-intelligence tools, and without this the prompt
 * bar went on showing the shorter list until a reload.
 */
export const projectChangeInvalidations = (
  sessionId: string,
): readonly (readonly unknown[])[] => [
  SESSION_STATUS_KEY,
  ["session-files", sessionId],
  ["git-status"],
  toolsQueryKey(sessionId),
];

/**
 * Attach, re-anchor or detach, and tell everything that reads links to re-read.
 *
 * Shared by the header's picker and the Files sheet.
 */
export function useSessionProjectMutation(sessionId: string) {
  const queryClient = useQueryClient();

  return useMutation<ProjectLink[], Error, ProjectChange>({
    mutationFn: async (change) => {
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
    onSuccess: (projects) => {
      queryClient.setQueryData(sessionProjectsKey(sessionId), projects);
      for (const queryKey of projectChangeInvalidations(sessionId)) {
        void queryClient.invalidateQueries({ queryKey });
      }
    },
  });
}
