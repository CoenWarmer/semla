import { useMemo } from "react";
import { useSessionMessagesReader } from "./use-session-messages";
import { recentPromptCost } from "@/lib/context-composition";

export function useSessionPromptCost(sessionId: string): number | null {
  const messages = useSessionMessagesReader(sessionId).data?.messages;
  return useMemo(
    () => (messages ? recentPromptCost(messages) : null),
    [messages],
  );
}
