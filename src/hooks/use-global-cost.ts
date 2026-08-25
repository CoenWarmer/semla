import { useQuery } from "@tanstack/react-query";

export type GlobalCost = { cost: number; tokens: number };

const fetchGlobalCost = async (): Promise<GlobalCost> => {
  const response = await fetch("/api/stats/usage");
  if (!response.ok) throw new Error("Unable to load usage stats.");
  return response.json() as Promise<GlobalCost>;
};

export function useGlobalCost() {
  return useQuery({
    queryFn: fetchGlobalCost,
    queryKey: ["global-cost"],
    staleTime: 30_000,
  });
}
