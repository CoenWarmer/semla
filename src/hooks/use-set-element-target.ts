import { useMutation } from "@tanstack/react-query";

export type SetElementTargetInput = {
  path: string;
};

export type SetElementTargetResponse = {
  path: string;
  project: string;
};

const setElementTarget = async (
  sessionId: string | undefined,
  { path }: SetElementTargetInput,
): Promise<SetElementTargetResponse> => {
  const response = await fetch(`/api/sessions/${sessionId}/element-target`, {
    body: JSON.stringify({ path }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(body?.error ?? "Unable to open that element's source.");
  }

  return body as SetElementTargetResponse;
};

export const useSetElementTarget = (sessionId: string | undefined) =>
  useMutation<SetElementTargetResponse, Error, SetElementTargetInput>({
    mutationFn: (input) => setElementTarget(sessionId, input),
  });
