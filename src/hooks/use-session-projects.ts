"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

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
 * Attach, re-anchor or detach, and tell everything that reads links to re-read.
 *
 * Shared by the header's picker and the Files sheet, because the list of things
 * to invalidate is the interesting part and two copies of it would drift: the
 * badges and the sidebar chips come from the status poll, the file tree's roots
 * from the files listing, and the branch state from its own query.
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
      void queryClient.invalidateQueries({ queryKey: SESSION_STATUS_KEY });
      void queryClient.invalidateQueries({
        queryKey: ["session-files", sessionId],
      });
      void queryClient.invalidateQueries({ queryKey: ["git-status"] });
    },
  });
}
