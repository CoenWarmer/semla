"use client";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useUpdateSystemPrompt, useUserSettings } from "@/hooks/use-user-settings";
import { DEFAULT_SYSTEM_PROMPT } from "@/lib/pi/system-prompt";
import { useState } from "react";

export function SystemPromptEditor() {
  const { data: settings, isPending } = useUserSettings();
  const updateMutation = useUpdateSystemPrompt();

  // null = no pending edit; the displayed value is derived from settings.
  // string = user is editing; we show their in-progress value.
  const [pendingValue, setPendingValue] = useState<string | null>(null);

  const savedValue = settings?.system_prompt ?? DEFAULT_SYSTEM_PROMPT;
  const value = pendingValue ?? savedValue;
  const isDirty = pendingValue !== null && pendingValue !== savedValue;
  const isDefault = value === DEFAULT_SYSTEM_PROMPT;

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setPendingValue(e.target.value);
  };

  const handleSave = () => {
    updateMutation.mutate(
      { systemPrompt: value || null },
      { onSuccess: () => setPendingValue(null) }
    );
  };

  const handleReset = () => {
    setPendingValue(DEFAULT_SYSTEM_PROMPT);
  };

  return (
    <div className="space-y-3">
      <Textarea
        className="font-mono text-sm min-h-48 resize-y"
        disabled={isPending}
        onChange={handleChange}
        placeholder={DEFAULT_SYSTEM_PROMPT}
        value={isPending ? "" : value}
      />
      <div className="flex items-center gap-2">
        <Button
          disabled={!isDirty || updateMutation.isPending}
          onClick={handleSave}
          size="sm"
        >
          {updateMutation.isPending ? "Saving…" : "Save"}
        </Button>
        {!isDefault && (
          <Button onClick={handleReset} size="sm" variant="ghost">
            Reset to default
          </Button>
        )}
        {updateMutation.isError && (
          <span className="text-destructive text-sm">
            {updateMutation.error.message}
          </span>
        )}
        {updateMutation.isSuccess && pendingValue === null && (
          <span className="text-muted-foreground text-sm">Saved</span>
        )}
      </div>
    </div>
  );
}
