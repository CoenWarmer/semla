import { useQuery } from "@tanstack/react-query";

export type SessionMessage = {
  createdAt: string;
  id: string;
  inputTokens?: number;
  role: "assistant" | "user";
  text: string;
  tokenUsage?: { cost: number; total: number };
};

/** A tool the assistant invoked, rendered as a marker on the timeline. */
export type SessionToolCall = {
  createdAt: string;
  errorText?: string;
  id: string;
  isError?: boolean;
  messageId: string;
  name: string;
  params?: Record<string, string>;
  resultAt?: string;
  resultText?: string;
  summary?: string;
};

export type SessionMessagesResult = {
  contextWindow: number | null;
  messages: SessionMessage[];
  toolCalls: SessionToolCall[];
};

export const sessionMessagesQueryKey = (sessionId: string) =>
  ["session-messages", sessionId] as const;

const fetchSessionMessages = async (sessionId: string): Promise<SessionMessagesResult> => {
  const response = await fetch(`/api/sessions/${sessionId}/messages`);

  if (!response.ok) {
    throw new Error("Unable to load this session.");
  }

  return response.json() as Promise<SessionMessagesResult>;
};

export const useSessionMessages = (sessionId: string) =>
  useQuery({
    queryFn: () => fetchSessionMessages(sessionId),
    queryKey: sessionMessagesQueryKey(sessionId),
  });
