"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input";
import { GoalEditor } from "@/components/goal-editor";
import { usePendingPrompt } from "@/components/pending-prompt-provider";
import {
  PromptEditor,
  type PromptEditorModel,
} from "@/components/prompt-editor";

export function NewSessionClient({ defaultTools }: { defaultTools: string[] }) {
  const router = useRouter();
  const { set: setPendingPrompt } = usePendingPrompt();
  const [goal, setGoal] = useState<string | null>(null);
  const [error, setError] = useState<string>();

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

      setError(undefined);

      const res = await fetch("/api/sessions", { method: "POST" });
      const body = await res.json().catch(() => null);

      if (!res.ok || !body?.id) {
        setError("Could not create a new session. Please try again.");
        return;
      }

      // The session page submits this once it mounts: the first turn's stream
      // only reaches the request that starts it, so it has to be started there.
      setPendingPrompt(body.id, { goal, model, text, tools });

      router.replace(`/sessions/${body.id}`);
    },
    [goal, router, setPendingPrompt],
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-20 py-4">
        <div className="flex w-full max-w-2xl flex-col gap-2">
          <PromptEditor
            defaultTools={defaultTools}
            onSubmit={handleSubmit}
            goalEditor={
              <GoalEditor goal={goal} onSave={handleGoalSave} variant="block" />
            }
          />
          {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
        </div>
      </div>
    </div>
  );
}
