"use client";

import { useState } from "react";
import type { ContextCheckResult } from "@/app/api/sessions/[id]/context-check/route";

type CompositionMode = "absolute" | "relative";

export function SessionContextWindowBar({
  result,
}: {
  result: ContextCheckResult | null;
}) {
  const [compositionMode, setCompositionMode] =
    useState<CompositionMode>("absolute");

  if (!result) return null;

  return (
    <div className="shrink-0 border-b border-border/40 px-6 py-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-foreground">Composition</span>
        {result.dimensions.composition.contextWindowFraction != null && (
          <button
            className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            onClick={() =>
              setCompositionMode((m: CompositionMode) =>
                m === "absolute" ? "relative" : "absolute",
              )
            }
            title={
              compositionMode === "absolute"
                ? "Switch to proportional view"
                : "Switch to context window view"
            }
          >
            {compositionMode === "absolute" ? "vs. context window" : "proportional"}
          </button>
        )}
      </div>
      <CompositionBar
        assistantFraction={result.dimensions.composition.assistantFraction}
        contextWindowFraction={result.dimensions.composition.contextWindowFraction}
        mode={compositionMode}
        systemPromptFraction={result.dimensions.composition.systemPromptFraction}
        toolResultFraction={result.dimensions.composition.toolResultFraction}
        userFraction={result.dimensions.composition.userFraction}
      />
    </div>
  );
}

function CompositionBar({
  assistantFraction,
  contextWindowFraction,
  mode,
  systemPromptFraction,
  toolResultFraction,
  userFraction,
}: {
  assistantFraction: number;
  contextWindowFraction: number | null;
  mode: CompositionMode;
  systemPromptFraction: number;
  toolResultFraction: number;
  userFraction: number;
}) {
  const scale =
    mode === "absolute" && contextWindowFraction != null
      ? contextWindowFraction
      : 1;

  const seg = {
    system: systemPromptFraction * scale,
    user: userFraction * scale,
    assistant: assistantFraction * scale,
    toolResult: toolResultFraction * scale,
  };
  const remainder =
    mode === "absolute" && contextWindowFraction != null
      ? Math.max(0, 1 - contextWindowFraction)
      : 0;

  const pct = (f: number) => `${Math.round(f * 100)}%`;

  return (
    <div className="mt-1 mb-0.5">
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
        {seg.system > 0.001 && (
          <div
            className="bg-emerald-500"
            style={{ flexBasis: 0, flexGrow: seg.system }}
            title={`System prompt: ${pct(systemPromptFraction)}`}
          />
        )}
        <div
          className="bg-blue-500"
          style={{ flexBasis: 0, flexGrow: seg.user }}
          title={`User: ${pct(userFraction)}`}
        />
        <div
          className="bg-violet-500"
          style={{ flexBasis: 0, flexGrow: seg.assistant }}
          title={`Assistant: ${pct(assistantFraction)}`}
        />
        <div
          className="bg-amber-500"
          style={{ flexBasis: 0, flexGrow: seg.toolResult }}
          title={`Tool results: ${pct(toolResultFraction)}`}
        />
        {remainder > 0.001 && (
          <div style={{ flexBasis: 0, flexGrow: remainder }} />
        )}
      </div>
      <div className="mt-1 flex flex-wrap gap-3 text-[10px] text-muted-foreground">
        {systemPromptFraction > 0.001 && (
          <span>
            <span className="inline-block size-1.5 rounded-full bg-emerald-500 mr-1 align-middle" />
            System {pct(systemPromptFraction)}
          </span>
        )}
        <span>
          <span className="inline-block size-1.5 rounded-full bg-blue-500 mr-1 align-middle" />
          User {pct(userFraction)}
        </span>
        <span>
          <span className="inline-block size-1.5 rounded-full bg-violet-500 mr-1 align-middle" />
          Assistant {pct(assistantFraction)}
        </span>
        <span>
          <span className="inline-block size-1.5 rounded-full bg-amber-500 mr-1 align-middle" />
          Tool results {pct(toolResultFraction)}
        </span>
        {mode === "absolute" && contextWindowFraction != null && (
          <span className="ml-auto text-muted-foreground/60">
            {pct(contextWindowFraction)} of context window
          </span>
        )}
      </div>
    </div>
  );
}
