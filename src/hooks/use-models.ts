import { useQuery } from "@tanstack/react-query";

export type PiModel = {
  modelId: string;
  name: string;
  provider: string;
};

export const modelsQueryKey = ["models"] as const;

const fetchModels = async (): Promise<PiModel[]> => {
  const response = await fetch("/api/models");

  if (!response.ok) {
    throw new Error("Unable to load Pi models.");
  }

  const { models } = (await response.json()) as { models: PiModel[] };
  return models;
};

export const useModels = () =>
  useQuery({
    queryFn: fetchModels,
    queryKey: modelsQueryKey,
  });
