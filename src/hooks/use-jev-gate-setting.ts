"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

interface JevGateSetting {
  enabled: boolean;
}

export const jevGateSettingQueryKey = ["jev-gate-setting"] as const;

async function fetchJevGateSetting(): Promise<JevGateSetting> {
  const response = await fetch("/api/jev-gate");
  if (!response.ok) {
    throw new Error("Unable to load the jev-gate setting.");
  }
  return response.json() as Promise<JevGateSetting>;
}

async function updateJevGateSetting(
  enabled: boolean,
): Promise<JevGateSetting> {
  const response = await fetch("/api/jev-gate", {
    body: JSON.stringify({ enabled }),
    headers: { "Content-Type": "application/json" },
    method: "PUT",
  });
  if (!response.ok) {
    throw new Error("Unable to save the jev-gate setting.");
  }
  return response.json() as Promise<JevGateSetting>;
}

export function useJevGateSetting() {
  return useQuery({
    queryFn: fetchJevGateSetting,
    queryKey: jevGateSettingQueryKey,
  });
}

export function useUpdateJevGateSetting() {
  const queryClient = useQueryClient();

  return useMutation<
    JevGateSetting,
    Error,
    boolean,
    { previous: JevGateSetting | undefined }
  >({
    mutationFn: updateJevGateSetting,
    onError: (_error, _enabled, context) => {
      queryClient.setQueryData(jevGateSettingQueryKey, context?.previous);
    },
    onMutate: async (enabled) => {
      await queryClient.cancelQueries({
        queryKey: jevGateSettingQueryKey,
      });
      const previous = queryClient.getQueryData<JevGateSetting>(
        jevGateSettingQueryKey,
      );
      queryClient.setQueryData(jevGateSettingQueryKey, { enabled });
      return { previous };
    },
    onSuccess: (setting) => {
      queryClient.setQueryData(jevGateSettingQueryKey, setting);
    },
  });
}
