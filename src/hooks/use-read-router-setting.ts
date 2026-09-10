"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

interface ReadRouterSetting {
  enabled: boolean;
}

export const readRouterSettingQueryKey = ["read-router-setting"] as const;

async function fetchReadRouterSetting(): Promise<ReadRouterSetting> {
  const response = await fetch("/api/read-router");
  if (!response.ok) {
    throw new Error("Unable to load the read-router setting.");
  }
  return response.json() as Promise<ReadRouterSetting>;
}

async function updateReadRouterSetting(
  enabled: boolean,
): Promise<ReadRouterSetting> {
  const response = await fetch("/api/read-router", {
    body: JSON.stringify({ enabled }),
    headers: { "Content-Type": "application/json" },
    method: "PUT",
  });
  if (!response.ok) {
    throw new Error("Unable to save the read-router setting.");
  }
  return response.json() as Promise<ReadRouterSetting>;
}

export function useReadRouterSetting() {
  return useQuery({
    queryFn: fetchReadRouterSetting,
    queryKey: readRouterSettingQueryKey,
  });
}

export function useUpdateReadRouterSetting() {
  const queryClient = useQueryClient();

  return useMutation<
    ReadRouterSetting,
    Error,
    boolean,
    { previous: ReadRouterSetting | undefined }
  >({
    mutationFn: updateReadRouterSetting,
    onError: (_error, _enabled, context) => {
      queryClient.setQueryData(readRouterSettingQueryKey, context?.previous);
    },
    onMutate: async (enabled) => {
      await queryClient.cancelQueries({
        queryKey: readRouterSettingQueryKey,
      });
      const previous =
        queryClient.getQueryData<ReadRouterSetting>(
          readRouterSettingQueryKey,
        );
      queryClient.setQueryData(readRouterSettingQueryKey, { enabled });
      return { previous };
    },
    onSuccess: (setting) => {
      queryClient.setQueryData(readRouterSettingQueryKey, setting);
    },
  });
}
