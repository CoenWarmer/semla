import { useEffect, useRef } from "react";

import type { SessionMessage } from "@/hooks/use-session-messages";
import { useTriggerContextCheck } from "@/hooks/use-context-check";

/** After every 10th user prompt, run a background context-quality check. */
export function usePeriodicContextCheck({
  isActive,
  messages,
  sessionId,
}: {
  isActive: boolean;
  messages: readonly SessionMessage[];
  sessionId: string;
}) {
  // `mutate`, not the mutation: `useMutation` returns a fresh result object
  // every render, which re-ran this effect on every render of the page.
  const trigger = useTriggerContextCheck(sessionId).mutate;

  const wasActiveRef = useRef(false);
  useEffect(() => {
    const turnJustEnded = wasActiveRef.current && !isActive;
    wasActiveRef.current = isActive;
    if (!turnJustEnded) return;

    const userMessageCount = messages.filter((m) => m.role === "user").length;
    if (userMessageCount > 0 && userMessageCount % 10 === 0) trigger();
  }, [isActive, messages, trigger]);
}
