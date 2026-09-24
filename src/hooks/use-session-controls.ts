import { useMutation } from "@tanstack/react-query";

const stopSession = async (sessionId: string): Promise<void> => {
  const response = await fetch(`/api/sessions/${sessionId}/stop`, { method: "POST" });

  if (!response.ok) {
    throw new Error("Unable to stop session.");
  }
};

const compactSession = async (sessionId: string): Promise<void> => {
  const response = await fetch(`/api/sessions/${sessionId}/compact`, { method: "POST" });

  if (!response.ok) {
    throw new Error("Unable to compact session.");
  }
};

export const useStopSession = (sessionId: string) =>
  useMutation({
    mutationFn: () => stopSession(sessionId),
    onError: (error: unknown) => {
      console.warn("[session] stop failed:", error);
    },
  });

export const useCompactSession = (sessionId: string) =>
  useMutation({
    mutationFn: () => compactSession(sessionId),
    onError: (error: unknown) => {
      console.warn("[session] compact failed:", error);
    },
  });

export const useSessionControls = (sessionId: string) => {
  const stopMutation = useStopSession(sessionId);
  const compactMutation = useCompactSession(sessionId);

  return {
    compact: compactMutation.mutate,
    stop: stopMutation.mutate,
  };
};
