"use client";

import { useRouter } from "next/navigation";

import { useCallback, useEffect, useState } from "react";
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input";
import { GoalEditor } from "@/components/goal-editor";
import { usePendingPrompt } from "@/components/pending-prompt-provider";
import {
  PromptEditor,
  type PromptEditorModel,
} from "@/components/prompt-editor";

export function NewSessionClient({
  defaultTools,
  project,
}: {
  defaultTools: string[];
  /** Workspace-relative project this session should be anchored to, if any. */
  project?: string | null;
}) {
  const router = useRouter();
  const { set: setPendingPrompt } = usePendingPrompt();
  const [goal, setGoal] = useState<string | null>(null);

  /**
   * The session's id, minted here rather than by Postgres.
   *
   * Waiting for the database to name the session cost two round trips before
   * anything moved: the POST, and then the RSC fetch for a route whose href was
   * unknown until it returned. Knowing the id up front makes the destination
   * prefetchable, so the click itself does no network at all.
   */
  const [sessionId] = useState(() => crypto.randomUUID());

  /**
   * `new=1` tells the session page that a session with no record yet is
   * expected rather than missing, so this href can be rendered — and therefore
   * prefetched — before the row exists.
   */
  const href = `/sessions/${sessionId}?new=1`;

  useEffect(() => {
    router.prefetch(href);
  }, [href, router]);

  const handleGoalSave = useCallback(async (next: string | null) => {
    setGoal(next);
  }, []);

  const handleSubmit = useCallback(
    async (
      message: PromptInputMessage,
      model: PromptEditorModel,
      tools: string[],
    ) => {
      const text = message.text.trim();
      if (!text) return;

      // Nothing is awaited here, and nothing is fetched. The session page
      // submits the prompt once it mounts — the first turn's stream only
      // reaches the request that starts it — and it creates the session on the
      // way, which is why `create` rides along. Creating it here instead is
      // what used to make this click wait.
      //
      // Still created with the first prompt rather than when the project was
      // chosen, so a card opened and abandoned leaves nothing behind. The
      // project has been carried in the URL until now.
      setPendingPrompt(sessionId, {
        create: { project: project ?? null, title: project ?? "New Session" },
        goal,
        model,
        text,
        tools,
      });

      router.replace(href);
    },
    [goal, href, project, router, sessionId, setPendingPrompt],
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-20 py-4">
        <div className="flex w-full max-w-2xl flex-col gap-2">
          <PromptEditor
            defaultTools={defaultTools}
            onSubmit={handleSubmit}
            goalEditor={
              <GoalEditor
                autoFocus={!goal?.trim()}
                goal={goal}
                onSave={handleGoalSave}
                variant="block"
              />
            }
          />
        </div>
      </div>
    </div>
  );
}
