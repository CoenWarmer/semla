import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export type UserSettings = {
  default_model_id: string | null;
  default_model_provider: string | null;
  system_prompt: string | null;
};

type UpdateUserSettingsInput = {
  defaultModelId: string;
  defaultModelProvider: string;
};

type UpdateSystemPromptInput = {
  systemPrompt: string | null;
};

export const userSettingsQueryKey = ["user-settings"] as const;

const fetchUserSettings = async (): Promise<UserSettings | null> => {
  const response = await fetch("/api/user-settings");

  if (!response.ok) {
    throw new Error("Unable to load user settings.");
  }

  const { settings } = (await response.json()) as {
    settings: UserSettings | null;
  };

  return settings;
};

const updateUserSettings = async ({
  defaultModelId,
  defaultModelProvider,
}: UpdateUserSettingsInput): Promise<UserSettings> => {
  const response = await fetch("/api/user-settings", {
    body: JSON.stringify({ defaultModelId, defaultModelProvider }),
    headers: { "Content-Type": "application/json" },
    method: "PUT",
  });

  if (!response.ok) {
    throw new Error("Unable to save the default model.");
  }

  const { settings } = (await response.json()) as { settings: UserSettings };
  return settings;
};

export const useUserSettings = () =>
  useQuery({
    queryFn: fetchUserSettings,
    queryKey: userSettingsQueryKey,
  });

const updateSystemPrompt = async ({ systemPrompt }: UpdateSystemPromptInput): Promise<UserSettings> => {
  const response = await fetch("/api/user-settings", {
    body: JSON.stringify({ systemPrompt }),
    headers: { "Content-Type": "application/json" },
    method: "PUT",
  });

  if (!response.ok) {
    throw new Error("Unable to save system prompt.");
  }

  const { settings } = (await response.json()) as { settings: UserSettings };
  return settings;
};

export const useUpdateSystemPrompt = () => {
  const queryClient = useQueryClient();

  return useMutation<
    UserSettings,
    Error,
    UpdateSystemPromptInput,
    { previousSettings: UserSettings | null | undefined }
  >({
    mutationFn: updateSystemPrompt,
    onError: (_error, _variables, context) => {
      if (context) {
        queryClient.setQueryData(userSettingsQueryKey, context.previousSettings);
      }
    },
    onMutate: async ({ systemPrompt }) => {
      await queryClient.cancelQueries({ queryKey: userSettingsQueryKey });
      const previousSettings = queryClient.getQueryData<UserSettings | null>(userSettingsQueryKey);
      queryClient.setQueryData<UserSettings | null>(userSettingsQueryKey, (prev) =>
        prev ? { ...prev, system_prompt: systemPrompt } : prev
      );
      return { previousSettings };
    },
    onSuccess: (settings) => {
      queryClient.setQueryData(userSettingsQueryKey, settings);
    },
  });
};

export const useUpdateUserSettings = () => {
  const queryClient = useQueryClient();

  return useMutation<
    UserSettings,
    Error,
    UpdateUserSettingsInput,
    { previousSettings: UserSettings | null | undefined }
  >({
    mutationFn: updateUserSettings,
    onError: (_error, _variables, context) => {
      if (context) {
        queryClient.setQueryData(
          userSettingsQueryKey,
          context.previousSettings
        );
      }
    },
    onMutate: async ({ defaultModelId, defaultModelProvider }) => {
      await queryClient.cancelQueries({ queryKey: userSettingsQueryKey });
      const previousSettings = queryClient.getQueryData<UserSettings | null>(
        userSettingsQueryKey
      );

      queryClient.setQueryData<UserSettings | null>(userSettingsQueryKey, (prev) =>
        prev
          ? { ...prev, default_model_id: defaultModelId, default_model_provider: defaultModelProvider }
          : { default_model_id: defaultModelId, default_model_provider: defaultModelProvider, system_prompt: null }
      );

      return { previousSettings };
    },
    onSuccess: (settings) => {
      queryClient.setQueryData(userSettingsQueryKey, settings);
    },
  });
};
