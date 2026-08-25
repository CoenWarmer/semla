"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input";
import { PromptEditor, type PromptEditorModel } from "@/components/prompt-editor";

const PENDING_PROMPT_KEY = "semla.pending-prompt";

export function NewSessionClient({ defaultTools }: { defaultTools: string[] }) {
  const router = useRouter();
  const [error, setError] = useState<string>();

  const handleSubmit = useCallback(
    async (message: PromptInputMessage, model: PromptEditorModel, tools: string[]) => {
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
        JSON.stringify({ model, text, tools }),
      );

      router.replace(`/sessions/${body.id}`);
      router.refresh();
    },
    [router],
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-20 py-4">
        <div className="w-full max-w-2xl">
          <PromptEditor defaultTools={defaultTools} onSubmit={handleSubmit} />
          {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
        </div>
      </div>
    </div>
  );
}

export { PENDING_PROMPT_KEY };
