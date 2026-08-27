"use client";

import { useState } from "react";
import type { ContextCheckResult } from "@/app/api/sessions/[id]/context-check/route";

type CompositionMode = "absolute" | "relative";

export function SessionContextWindowBar({
  result,
}: {
  result: ContextCheckResult | null;
}) {
  const [mode, setMode] = useState<CompositionMode>("absolute");

  if (!result) return null;

  const { assistantFraction, contextWindowFraction, systemPromptFraction, toolResultFraction, userFraction } =
    result.dimensions.composition;

  const scale = mode === "absolute" && contextWindowFraction != null ? contextWindowFraction : 1;
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
    <div className="group relative shrink-0">
      {/* Collapsed — always in-flow, defines the 4px height */}
      <div className="flex h-1 w-full overflow-hidden border-b border-border/40 bg-muted">
        {seg.system > 0.001 && (
          <div
            className="bg-emerald-500"
            style={{ flexBasis: 0, flexGrow: seg.system }}
            title={`System prompt: ${pct(seg.system)}`}
          />
        )}
        <div
          className="bg-blue-500"
          style={{ flexBasis: 0, flexGrow: seg.user }}
          title={`User: ${pct(seg.user)}`}
        />
        <div
          className="bg-violet-500"
          style={{ flexBasis: 0, flexGrow: seg.assistant }}
          title={`Assistant: ${pct(seg.assistant)}`}
        />
        <div
          className="bg-amber-500"
          style={{ flexBasis: 0, flexGrow: seg.toolResult }}
          title={`Tool results: ${pct(seg.toolResult)}`}
        />
        {remainder > 0.001 && (
          <div style={{ flexBasis: 0, flexGrow: remainder }} />
        )}
      </div>

      {/* Expanded — absolute, shown on hover, doesn't affect layout */}
      <div className="pointer-events-none absolute left-0 right-0 top-full z-20 border-b border-border/40 bg-background px-6 pb-2.5 pt-2 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs font-medium text-foreground">Composition</span>
          {contextWindowFraction != null && (
            <button
              className="text-[10px] text-muted-foreground transition-colors hover:text-foreground"
              onClick={() =>
                setMode((m: CompositionMode) => (m === "absolute" ? "relative" : "absolute"))
              }
              title={mode === "absolute" ? "Switch to proportional view" : "Switch to context window view"}
            >
              {mode === "absolute" ? "vs. context window" : "proportional"}
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-3 text-[10px] text-muted-foreground">
          {seg.system > 0.001 && (
            <span>
              <span className="mr-1 inline-block size-1.5 rounded-full bg-emerald-500 align-middle" />
              System {pct(seg.system)}
            </span>
          )}
          <span>
            <span className="mr-1 inline-block size-1.5 rounded-full bg-blue-500 align-middle" />
            User {pct(seg.user)}
          </span>
          <span>
            <span className="mr-1 inline-block size-1.5 rounded-full bg-violet-500 align-middle" />
            Assistant {pct(seg.assistant)}
          </span>
          <span>
            <span className="mr-1 inline-block size-1.5 rounded-full bg-amber-500 align-middle" />
            Tool results {pct(seg.toolResult)}
          </span>
          {mode === "absolute" && contextWindowFraction != null && (
            <span className="ml-auto text-muted-foreground/60">
              {pct(contextWindowFraction)} of context window
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
