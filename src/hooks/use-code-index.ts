import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface ProjectIndexStatus {
  name: string;
  path: string;
  indexed: boolean;
  chunks: number | null;
  model: string | null;
  updated: string | null;
}

export const codeIndexQueryKey = ["code-index"] as const;

const fetchStatuses = async (): Promise<ProjectIndexStatus[]> => {
  const response = await fetch("/api/code-index");
  if (!response.ok) throw new Error("Unable to load code index status.");
  const { projects } = (await response.json()) as { projects: ProjectIndexStatus[] };
  return projects;
};

const act = async ({
  path,
  method,
}: {
  path: string;
  method: "POST" | "DELETE";
}): Promise<void> => {
  const response = await fetch("/api/code-index", {
    body: JSON.stringify({ path }),
    headers: { "Content-Type": "application/json" },
    method,
  });

  if (!response.ok) {
    // The route's own message is the useful one — "already running", or the
    // missing-credential explanation — where a generic string is a mystery.
    const { error } = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(error ?? "The request failed.");
  }
};

export const useCodeIndexStatus = () =>
  useQuery({ queryFn: fetchStatuses, queryKey: codeIndexQueryKey });

/**
 * Start or drop an index.
 *
 * A started run is deliberately *not* invalidated on success: the POST returns
 * 202 having only queued the work, so refetching immediately would show the
 * project exactly as it was. The SSE stream reports the run reaching a terminal
 * state, and that is what invalidates.
 */
export const useCodeIndexAction = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: act,
    onSuccess: (_result, { method }) => {
      if (method === "DELETE") {
        void queryClient.invalidateQueries({ queryKey: codeIndexQueryKey });
      }
    },
  });
};
