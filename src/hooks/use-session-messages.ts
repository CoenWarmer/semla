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
  /**
   * Earlier wordings of this prompt, oldest first, present only where it was
   * edited. Mirrors SessionTranscriptEntry.versions on the server.
   */
  versions?: string[];
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
  /** Cache-read cost rate in $/M tokens for the session's model. */
  cacheReadRatePerMToken?: number | null;
  messages: SessionMessage[];
  /**
   * Size of the system prompt this session's turns are sent with. Travels with
   * the transcript so the context-window bar can be computed here rather than
   * asking a second route to re-read the same transcript.
   */
  systemPromptChars?: number;
  toolCalls: SessionToolCall[];
};

/**
 * `leafId` is part of the key on purpose: two branches of the same session are
 * two different transcripts, and TanStack Query only knows to keep them apart
 * — and to refetch on navigation between them — if the key says so. Omitted
 * (rather than `null`) for the default/live view, so a plain session URL with
 * no `?leaf=` keeps the key it always had and no existing cache entry goes
 * stale just because this shipped. See docs/plans/branching-sessions.md §4.
 */
export const sessionMessagesQueryKey = (
  sessionId: string,
  leafId?: string | null,
): readonly (string | null)[] =>
  leafId ? ["session-messages", sessionId, leafId] : ["session-messages", sessionId];

const fetchSessionMessages = async (
  sessionId: string,
  leafId?: string | null,
): Promise<SessionMessagesResult> => {
  const url = leafId
    ? `/api/sessions/${sessionId}/messages?leaf=${encodeURIComponent(leafId)}`
    : `/api/sessions/${sessionId}/messages`;
  const response = await fetch(url);

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
  leafId?: string | null,
) => ({
  queryKey: sessionMessagesQueryKey(sessionId, leafId),
  refetchOnWindowFocus: !turnActive,
  refetchOnReconnect: !turnActive,
});

export const useSessionMessages = (
  sessionId: string,
  initialData?: SessionMessagesResult,
  /** True while a prompt turn is streaming. */
  turnActive = false,
  /**
   * The branch to load, from `?leaf=`. Undefined for the default view, which
   * is also the only case `initialData` — the server page's own render — is
   * valid for: the page never resolves a `?leaf=` today, so seeding it as
   * this query's initial data while asking for a specific branch would show
   * the wrong conversation until the real fetch overwrote it.
   */
  leafId?: string | null,
) =>
  useQuery({
    ...sessionMessagesQueryOptions(sessionId, turnActive, leafId),
    enabled: !!sessionId,
    initialData: leafId ? undefined : initialData,
    queryFn: () => fetchSessionMessages(sessionId, leafId),
  });
