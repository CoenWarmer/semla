import { useQuery } from "@tanstack/react-query";
import type { WikiLink, WikiPageMeta } from "@/lib/wiki/wiki-types";

export interface WikiApiResponse {
  initialized: boolean;
  registry: { pages: Record<string, WikiPageMeta> } | null;
  links: WikiLink[];
}

export const wikiGraphQueryKey = ["wiki"] as const;

const fetchWikiGraph = async (): Promise<WikiApiResponse> => {
  const response = await fetch("/api/wiki");

  if (!response.ok) {
    throw new Error(`wiki ${response.status}`);
  }

  return (await response.json()) as WikiApiResponse;
};

export const useWikiGraph = () =>
  useQuery<WikiApiResponse>({
    queryFn: fetchWikiGraph,
    queryKey: wikiGraphQueryKey,
    refetchInterval: 4000,
    staleTime: 0,
  });
