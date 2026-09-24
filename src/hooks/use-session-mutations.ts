import { useMutation } from "@tanstack/react-query";

export type RenameSessionInput = {
  id: string;
  title: string;
};

export type DeleteSessionInput = {
  id: string;
};

const renameSession = async ({ id, title }: RenameSessionInput): Promise<void> => {
  const response = await fetch(`/api/sessions/${id}`, {
    body: JSON.stringify({ title }),
    headers: { "Content-Type": "application/json" },
    method: "PATCH",
  });

  if (!response.ok) {
    throw new Error(`Unable to rename session: ${response.status}`);
  }
};

const deleteSession = async ({ id }: DeleteSessionInput): Promise<void> => {
  const response = await fetch(`/api/sessions/${id}`, {
    method: "DELETE",
  });

  if (!response.ok) {
    throw new Error(`Unable to delete session: ${response.status}`);
  }
};

export const useRenameSession = () =>
  useMutation({
    mutationFn: renameSession,
  });

export const useDeleteSession = () =>
  useMutation({
    mutationFn: deleteSession,
  });
