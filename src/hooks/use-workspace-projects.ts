import { useQuery } from "@tanstack/react-query";

import type { WorkspaceProject } from "@/lib/pi/workspace/workspace";

export const workspaceProjectsQueryKey = ["workspace-projects"] as const;

const fetchWorkspaceProjects = async (): Promise<WorkspaceProject[]> => {
  const response = await fetch("/api/projects");

  if (!response.ok) {
    throw new Error("Unable to load projects.");
  }

  return (await response.json()) as WorkspaceProject[];
};

export const useWorkspaceProjects = (enabled: boolean) =>
  useQuery<WorkspaceProject[]>({
    enabled,
    queryFn: fetchWorkspaceProjects,
    queryKey: workspaceProjectsQueryKey,
  });
