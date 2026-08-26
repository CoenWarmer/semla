"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input";
import { GoalEditor } from "@/components/goal-editor";
import {
  PromptEditor,
  type PromptEditorModel,
} from "@/components/prompt-editor";

export const PENDING_PROMPT_KEY = "semla.pending-prompt";

export function NewSessionClient({ defaultTools }: { defaultTools: string[] }) {
  const router = useRouter();
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

      sessionStorage.setItem(
        PENDING_PROMPT_KEY,
        JSON.stringify({ goal, model, text, tools }),
      );

      router.replace(`/sessions/${body.id}`);
    },
    [goal, router],
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
