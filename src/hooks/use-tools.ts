import { useQuery } from "@tanstack/react-query";

export type PiTools = {
  toggleableTools: string[];
  extensionTools: string[];
};

/**
 * Session-scoped: which extension tools exist depends on whether the session is
 * anchored on a project, so a session's answer must not be served from another
 * one's cache entry. Without an id — /sessions/new — the full set is correct,
 * because the first prompt will run anchored.
 */
export const toolsQueryKey = (sessionId?: string) =>
  ["tools", sessionId ?? null] as const;

const fetchTools = async (sessionId?: string): Promise<PiTools> => {
  const response = await fetch(
    sessionId ? `/api/tools?sessionId=${encodeURIComponent(sessionId)}` : "/api/tools",
  );

  if (!response.ok) {
    throw new Error("Unable to load Pi tools.");
  }

  return (await response.json()) as PiTools;
};

export const useTools = (sessionId?: string) =>
  useQuery({
    queryFn: () => fetchTools(sessionId),
    queryKey: toolsQueryKey(sessionId),
  });
