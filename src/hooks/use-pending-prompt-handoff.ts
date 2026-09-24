import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { type PendingPrompt, usePendingPrompt } from "@/components/pending-prompt-provider";
import type { usePromptMutation } from "@/hooks/use-prompt-mutation";
import { SESSION_STATUS_KEY } from "@/lib/session/session-status";

type PromptMutateAsync = ReturnType<typeof usePromptMutation>["mutation"]["mutateAsync"];

/**
 * Submit the first prompt of a session, handed over by /sessions/new.
 *
 * The mutation is started from a timeout rather than inline. useMutation
 * attaches its observer to the mutation inside mutate() — that is the only
 * place it ever attaches — while React detaches it on unsubscribe and never
 * re-attaches. Starting the mutation during this commit means StrictMode's
 * teardown detaches the observer permanently: the mutation runs, dispatches
 * "success", and reaches nobody, so isPending stays true forever even though
 * the turn finished. Deferring past the commit leaves the subscription stable
 * by the time mutate() runs. The handoff is cleared when read, so it is
 * cached here for StrictMode's second effect pass.
 */
export function usePendingPromptHandoff({
  promptMutateAsync,
  saveGoal,
  sessionId,
}: {
  promptMutateAsync: PromptMutateAsync;
  saveGoal: (goal: string) => Promise<void>;
  sessionId: string;
}) {
  const queryClient = useQueryClient();
  const { consume: consumePendingPrompt } = usePendingPrompt();

  const pendingPromptRef = useRef<{
    prompt: PendingPrompt | null;
    sessionId: string;
  } | null>(null);
  const submittedForRef = useRef<string | null>(null);

  useEffect(() => {
    if (submittedForRef.current === sessionId) return;

    if (pendingPromptRef.current?.sessionId !== sessionId) {
      pendingPromptRef.current = {
        prompt: consumePendingPrompt(sessionId),
        sessionId,
      };
    }

    const pending = pendingPromptRef.current.prompt;
    if (!pending?.text.trim()) return;

    const timer = setTimeout(() => {
      submittedForRef.current = sessionId;

      if (pending.goal) void saveGoal(pending.goal);

      // `pending.create` rides along in the request: the session may not exist
      // yet, and the prompt route creates it before running the turn. Creating
      // it from here first would put a second round trip between arriving on
      // this page and the agent starting.
      //
      // Rejections surface through the mutation's onError as streamError.
      promptMutateAsync(pending).catch(() => {});

      if (pending.create) {
        // The sidebar polls; nudge it so the new session appears now rather
        // than whenever the next poll lands.
        void queryClient.invalidateQueries({ queryKey: SESSION_STATUS_KEY });
      }
    }, 0);

    return () => clearTimeout(timer);
    // saveGoal is deliberately omitted: it changes identity whenever the goal
    // does, and rescheduling the timer on each change could starve it. It is
    // only read inside the timeout.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [consumePendingPrompt, promptMutateAsync, queryClient, sessionId]);
}
