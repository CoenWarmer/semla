"use client";

import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useModelTiers, useUpdateModelTiers } from "@/hooks/use-model-tiers";
import {
  formatModelSpecWithThinking,
  splitModelSpecThinking,
  THINKING_LEVELS,
  type ModelThinkingLevel,
} from "@/lib/pi/extensions/dynamic-workflows/src/model-spec.ts";
import { useQuery } from "@tanstack/react-query";
import { useState, useMemo } from "react";

type ModelOption = {
  spec: string;
  label: string;
};

const TIER_NAMES = ["small", "medium", "big"] as const;
type TierName = (typeof TIER_NAMES)[number];

const fetchModels = async (): Promise<ModelOption[]> => {
  const response = await fetch("/api/models");
  if (!response.ok) {
    throw new Error("Unable to load models.");
  }
  const { models } = (await response.json()) as {
    models: Array<{ modelId: string; name: string; provider: string }>;
  };

  return models.map((model) => ({
    spec: `${model.provider}/${model.modelId}`,
    label: `${model.provider}/${model.modelId}${model.name ? ` — ${model.name}` : ""}`,
  }));
};

export function ModelTierEditor() {
  const { data: tiersData, isPending: isLoadingTiers } = useModelTiers();
  const { data: modelsData, isPending: isLoadingModels } = useQuery({
    queryKey: ["models"],
    queryFn: fetchModels,
  });
  const updateMutation = useUpdateModelTiers();

  const models = useMemo(() => modelsData ?? [], [modelsData]);
  const knownSpecs = useMemo(() => models.map((m) => m.spec), [models]);

  // Decompose stored tiers from the server into model + thinking pairs.
  // Memoized on tiersData identity, which useQuery keeps stable.
  const decomposedSavedTiers = useMemo(() => {
    const savedTiers = tiersData?.exists ? tiersData.tiers : {};
    const decomposed: Record<TierName, { model: string; thinking?: ModelThinkingLevel }> = {
      small: { model: "", thinking: undefined },
      medium: { model: "", thinking: undefined },
      big: { model: "", thinking: undefined },
    };

    for (const tier of TIER_NAMES) {
      const stored = savedTiers[tier];
      const { modelSpec, thinkingLevel } = splitModelSpecThinking(stored, knownSpecs);
      decomposed[tier] = { model: modelSpec, thinking: thinkingLevel };
    }

    return decomposed;
  }, [tiersData, knownSpecs]);

  // Pending edits: null = no edit in progress; the displayed values come from the server.
  const [pendingTiers, setPendingTiers] = useState<Record<TierName, string> | null>(null);
  const [pendingThinking, setPendingThinking] = useState<Record<TierName, ModelThinkingLevel | undefined> | null>(
    null,
  );

  const displayTiers = pendingTiers ?? {
    small: decomposedSavedTiers.small.model,
    medium: decomposedSavedTiers.medium.model,
    big: decomposedSavedTiers.big.model,
  };
  const displayThinking = pendingThinking ?? ({
    small: decomposedSavedTiers.small.thinking,
    medium: decomposedSavedTiers.medium.thinking,
    big: decomposedSavedTiers.big.thinking,
  } as Record<TierName, ModelThinkingLevel | undefined>);

  const isDirty = (() => {
    if (pendingTiers === null || pendingThinking === null) return false;
    const savedTiers = tiersData?.exists ? tiersData.tiers : {};
    for (const tier of TIER_NAMES) {
      const composed = formatModelSpecWithThinking(pendingTiers[tier] || "", pendingThinking[tier]);
      const saved = savedTiers[tier] || "";
      if (composed !== saved) return true;
    }
    return false;
  })();

  const handleModelChange = (tier: TierName, value: string) => {
    setPendingTiers((prev) => ({ ...(prev ?? {}), [tier]: value } as Record<TierName, string>));
  };

  const handleThinkingChange = (tier: TierName, value: string | null) => {
    if (!value) return;
    setPendingThinking((prev) => ({
      ...(prev ?? {}),
      [tier]: value === "none" ? undefined : (value as ModelThinkingLevel),
    } as Record<TierName, ModelThinkingLevel | undefined>));
  };

  const handleSave = () => {
    if (!pendingTiers || !pendingThinking) return;

    // Compose model + thinking for storage, and filter out empty tiers.
    const composed: Record<string, string> = {};
    for (const tier of TIER_NAMES) {
      const model = pendingTiers[tier];
      if (model && model.trim().length > 0) {
        composed[tier] = formatModelSpecWithThinking(model, pendingThinking[tier]);
      }
    }

    updateMutation.mutate(
      { tiers: composed },
      {
        onSuccess: () => {
          setPendingTiers(null);
          setPendingThinking(null);
        },
      },
    );
  };

  const handleReset = () => {
    setPendingTiers(null);
    setPendingThinking(null);
  };

  return (
    <div className="space-y-4">
      {/*
        Two things the user needs to know:
        1. An untagged agent() call defaults to the "medium" tier once ANY config exists,
           so creating one changes routing for untagged agents too.
        2. An unrecognized tier name would silently fall back to the session model.
      */}
      <div className="rounded-xl border border-border/50 bg-muted/30 p-3 text-sm text-muted-foreground">
        <p>
          <strong>Note:</strong> Once configured, untagged <code className="text-xs">agent()</code> calls route to the{" "}
          <strong>medium</strong> tier. Tier names other than small/medium/big are ignored and fall back to the session
          model.
        </p>
      </div>

      <div className="space-y-3">
        {TIER_NAMES.map((tier) => (
          <div key={tier} className="grid grid-cols-[80px_1fr_180px] items-center gap-3">
            <label className="text-sm font-medium capitalize">{tier}</label>

            {/*
              Both callbacks are wired, and both are required.

              Base UI separates the *selected item* (onValueChange) from the
              *typed text* (onInputValueChange). A spec the operator types by
              hand — a model this host's catalogue does not list, or one
              carrying a thinking suffix — is never an item, so with only
              onValueChange the keystrokes stay in the input and are dropped on
              save. Free text is half the requirement, so it cannot depend on
              the value happening to exist in the list.
            */}
            <Combobox
              value={displayTiers[tier] || ""}
              onValueChange={(value) =>
                handleModelChange(tier, typeof value === "string" ? value : "")
              }
              onInputValueChange={(inputValue) => handleModelChange(tier, inputValue)}
              disabled={isLoadingTiers || isLoadingModels}
            >
              <ComboboxInput
                placeholder={isLoadingModels ? "Loading models…" : "Type or select a model"}
                className="font-mono text-xs"
                showClear
              />
              <ComboboxContent>
                <ComboboxList>
                  <ComboboxEmpty>No matching models</ComboboxEmpty>
                  {models.map((model) => (
                    <ComboboxItem key={model.spec} value={model.spec}>
                      {model.label}
                    </ComboboxItem>
                  ))}
                </ComboboxList>
              </ComboboxContent>
            </Combobox>

            <Select
              value={displayThinking[tier] ?? "none"}
              onValueChange={(value) => handleThinkingChange(tier, value ?? "none")}
              disabled={isLoadingTiers || !displayTiers[tier]}
            >
              <SelectTrigger className="h-9 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No thinking</SelectItem>
                {THINKING_LEVELS.map((level) => (
                  <SelectItem key={level} value={level}>
                    {level}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <Button disabled={!isDirty || updateMutation.isPending} onClick={handleSave} size="sm">
          {updateMutation.isPending ? "Saving…" : "Save"}
        </Button>
        {isDirty && (
          <Button onClick={handleReset} size="sm" variant="ghost">
            Reset
          </Button>
        )}
        {updateMutation.isError && (
          <span className="text-destructive text-sm">{updateMutation.error.message}</span>
        )}
        {updateMutation.isSuccess && !isDirty && <span className="text-muted-foreground text-sm">Saved</span>}
      </div>
    </div>
  );
}
