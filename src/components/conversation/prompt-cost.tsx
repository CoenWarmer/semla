"use client";

import { cn } from "@/lib/utils";

export function PromptCost({
  costPerPrompt,
}: {
  /** Median cost of this session's recent prompts, in USD. */
  costPerPrompt: number | null;
}) {
  if (costPerPrompt == null) return null;
  return (
    <span
      className={cn(
        "shrink-0 text-[12px] tabular-nums",
        costPerPrompt < 0.01
          ? "text-muted-foreground/60"
          : costPerPrompt < 0.05
            ? "text-muted-foreground"
            : costPerPrompt < 0.15
              ? "text-amber-500"
              : "text-red-500",
      )}
      title="Median cost of this session's recent prompts, across every model call each one made"
    >
      ≈
      {costPerPrompt < 0.01
        ? "<$0.01"
        : `$${costPerPrompt.toFixed(costPerPrompt >= 1 ? 2 : 3)}`}{" "}
      / prompt
    </span>
  );
}
