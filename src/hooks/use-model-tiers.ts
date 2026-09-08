import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export type ModelTiersResponse =
  | { exists: false; tiers: null }
  | { exists: true; tiers: Record<string, string> };

export type UpdateModelTiersInput = {
  tiers: Record<string, string>;
};

export const modelTiersQueryKey = ["model-tiers"] as const;

const fetchModelTiers = async (): Promise<ModelTiersResponse> => {
  const response = await fetch("/api/model-tiers");

  if (!response.ok) {
    throw new Error("Unable to load model tier configuration.");
  }

  return (await response.json()) as ModelTiersResponse;
};

const updateModelTiers = async ({ tiers }: UpdateModelTiersInput): Promise<ModelTiersResponse> => {
  const response = await fetch("/api/model-tiers", {
    body: JSON.stringify({ tiers }),
    headers: { "Content-Type": "application/json" },
    method: "PUT",
  });

  if (!response.ok) {
    const { error } = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(error ?? "Unable to save model tier configuration.");
  }

  return (await response.json()) as ModelTiersResponse;
};

export const useModelTiers = () =>
  useQuery({
    queryFn: fetchModelTiers,
    queryKey: modelTiersQueryKey,
  });

export const useUpdateModelTiers = () => {
  const queryClient = useQueryClient();

  return useMutation<
    ModelTiersResponse,
    Error,
    UpdateModelTiersInput,
    { previousTiers: ModelTiersResponse | undefined }
  >({
    mutationFn: updateModelTiers,
    onError: (_error, _variables, context) => {
      if (context) {
        queryClient.setQueryData(modelTiersQueryKey, context.previousTiers);
      }
    },
    onMutate: async ({ tiers }) => {
      await queryClient.cancelQueries({ queryKey: modelTiersQueryKey });
      const previousTiers = queryClient.getQueryData<ModelTiersResponse>(modelTiersQueryKey);

      queryClient.setQueryData<ModelTiersResponse>(modelTiersQueryKey, { exists: true, tiers });

      return { previousTiers };
    },
    onSuccess: (data) => {
      queryClient.setQueryData(modelTiersQueryKey, data);
    },
  });
};
