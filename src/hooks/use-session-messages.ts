import { useQuery } from "@tanstack/react-query";

export type SessionMessage = {
  createdAt: string;
  id: string;
  role: "assistant" | "user";
  text: string;
  tokenUsage?: { cost: number; total: number };
};

export const sessionMessagesQueryKey = (sessionId: string) =>
  ["session-messages", sessionId] as const;

const fetchSessionMessages = async (sessionId: string) => {
  const response = await fetch(`/api/sessions/${sessionId}/messages`);

  if (!response.ok) {
    throw new Error("Unable to load this session.");
  }

  const { messages } = (await response.json()) as {
    messages: SessionMessage[];
  };

  return messages;
};

export const useSessionMessages = (sessionId: string) =>
  useQuery({
    queryFn: () => fetchSessionMessages(sessionId),
    queryKey: sessionMessagesQueryKey(sessionId),
  });
