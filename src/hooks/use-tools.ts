import { useQuery } from "@tanstack/react-query";

export type PiTools = {
  toggleableTools: string[];
  extensionTools: string[];
};

export const toolsQueryKey = ["tools"] as const;

const fetchTools = async (): Promise<PiTools> => {
  const response = await fetch("/api/tools");

  if (!response.ok) {
    throw new Error("Unable to load Pi tools.");
  }

  return (await response.json()) as PiTools;
};

export const useTools = () =>
  useQuery({
    queryFn: fetchTools,
    queryKey: toolsQueryKey,
  });
