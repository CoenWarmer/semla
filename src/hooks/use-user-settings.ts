import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export type UserSettings = {
  default_model_id: string | null;
  default_model_provider: string | null;
};

type UpdateUserSettingsInput = {
  defaultModelId: string;
  defaultModelProvider: string;
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

      queryClient.setQueryData<UserSettings>(userSettingsQueryKey, {
        default_model_id: defaultModelId,
        default_model_provider: defaultModelProvider,
      });

      return { previousSettings };
    },
    onSuccess: (settings) => {
      queryClient.setQueryData(userSettingsQueryKey, settings);
    },
  });
};
