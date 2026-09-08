import type { FileMatch } from "@/lib/file-search";
import { useQuery } from "@tanstack/react-query";

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
/**
 * Ranked matches for a query, within one scope.
 *
 * Exported for the review panel's tree filter, which wants the same ranking
 * and the same caching but only the project scope and its own presentation —
 * duplicating the query key here would give two components two caches of the
 * same answer.
 */
export function useFileSearch(
  sessionId: string,
  query: string,
  scope: Scope,
  enabled = true,
) {
  return useQuery({
    enabled: enabled && query.length > 0,
    queryKey: ["session-file-search", sessionId, scope, query],
    queryFn: async (): Promise<SearchResponse> => {
      const params = new URLSearchParams({ q: query, scope });
      const res = await fetch(
        `/api/sessions/${sessionId}/files/search?${params}`,
      );
      if (!res.ok) throw new Error("Unable to search files");
      return res.json();
    },
    // Results for a given query do not change while the drawer is open, and
    // keeping the previous ones stops the list blanking on every keystroke.
    placeholderData: (previous) => previous,
    staleTime: 30_000,
  });
}
