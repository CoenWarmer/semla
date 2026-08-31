import { useQuery } from "@tanstack/react-query";

export type SessionMessage = {
  createdAt: string;
  id: string;
  inputTokens?: number;
  role: "assistant" | "user";
  text: string;
  /** The model's reasoning for this turn, when the provider returned any. */
  thinking?: string;
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

/**
 * Query options for a session's transcript.
 *
 * A turn's entries are only persisted once it ends, so mid-turn the server
 * still holds the *pre-turn* transcript. Refetching then overwrites the
 * optimistic user message with a list that does not contain it, and the prompt
 * disappears from the conversation until the turn finishes and onSettled
 * invalidates. Focus and reconnect are the refetches that fire unbidden, so
 * they are the ones paused; an explicit invalidate still refetches.
 *
 * Exported so the intent is pinned by a test rather than living as two
 * negations inside a hook call.
 */
export const sessionMessagesQueryOptions = (
  sessionId: string,
  turnActive: boolean,
) => ({
  queryKey: sessionMessagesQueryKey(sessionId),
  refetchOnWindowFocus: !turnActive,
  refetchOnReconnect: !turnActive,
});

export const useSessionMessages = (
  sessionId: string,
  initialData?: SessionMessagesResult,
  /** True while a prompt turn is streaming. */
  turnActive = false,
) =>
  useQuery({
    ...sessionMessagesQueryOptions(sessionId, turnActive),
    initialData,
    queryFn: () => fetchSessionMessages(sessionId),
  });
