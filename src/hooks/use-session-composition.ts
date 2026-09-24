import {
  CompositionMessage,
  CompositionToolCall,
  sessionComposition,
} from "@/lib/context-composition";
import { UseQueryResult } from "@tanstack/react-query";
import { useMemo } from "react";
import { SessionMessagesResult } from "./use-session-messages";

export function useSessionComposition({
  messages,
  messagesQuery,
  toolCalls,
}: {
  messages: CompositionMessage[];
  messagesQuery: UseQueryResult<NoInfer<SessionMessagesResult>, Error>;
  toolCalls: CompositionToolCall[];
}) {
  const composition = useMemo(
    () =>
      sessionComposition({
        contextWindow: messagesQuery.data?.contextWindow ?? null,
        messages,
        systemPromptChars: messagesQuery.data?.systemPromptChars ?? 0,
        toolCalls,
      }),
    [
      messages,
      messagesQuery.data?.contextWindow,
      messagesQuery.data?.systemPromptChars,
      toolCalls,
    ],
  );

  return composition;
}
