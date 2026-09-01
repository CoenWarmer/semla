"use client";

import { useState } from "react";
import type { CompositionBreakdown } from "@/lib/context-composition";

type CompositionMode = "absolute" | "relative";

/**
 * What the context window holds, as a strip under the title bar.
 *
 * Fed by the composition endpoint rather than a context inspection, so it is
 * there from the moment a session opens instead of appearing once somebody
 * presses Inspect.
 */
export function SessionContextWindowBar({
  composition,
}: {
  composition: CompositionBreakdown | null | undefined;
}) {
  const [mode, setMode] = useState<CompositionMode>("absolute");

  if (!composition) return null;

  const {
    assistantFraction,
    contextWindowEstimated,
    contextWindowFraction,
    systemPromptFraction,
    toolResultFraction,
    userFraction,
  } = composition;

  // Nothing measured yet — an empty strip beats four zero-width segments.
  if (
    systemPromptFraction + userFraction + assistantFraction + toolResultFraction ===
    0
  ) {
    return <div className="h-2 w-full shrink-0 border-b border-border/40 bg-muted" />;
  }

  // Unknown is not full. Without a window size there is nothing to be a
  // fraction of, so the bar shows proportions and says so — scaling to 1
  // drew a brand-new session, whose only content is its system prompt, as a
  // context window at capacity.
  const windowKnown = contextWindowFraction != null;
  const absolute = mode === "absolute" && windowKnown;
  const scale = absolute ? contextWindowFraction : 1;
  const seg = {
    system: systemPromptFraction * scale,
    user: userFraction * scale,
    assistant: assistantFraction * scale,
    toolResult: toolResultFraction * scale,
  };
  const remainder = absolute ? Math.max(0, 1 - contextWindowFraction) : 0;
  const pct = (f: number) => `${Math.round(f * 100)}%`;

  return (
    <div className="group relative shrink-0">
      {/* Collapsed — always in-flow, defines the strip's height */}
      <div
        className={`flex h-2 w-full overflow-hidden border-b border-border/40 bg-muted${
          windowKnown ? "" : " opacity-40"
        }`}
      >
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
          <span className="text-xs font-medium text-foreground">
            Composition
          </span>
          {windowKnown && (
            <button
              className="text-[10px] text-muted-foreground transition-colors hover:text-foreground"
              onClick={() =>
                setMode((m: CompositionMode) =>
                  m === "absolute" ? "relative" : "absolute",
                )
              }
              title={
                mode === "absolute"
                  ? "Switch to proportional view"
                  : "Switch to context window view"
              }
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
          {absolute && (
            <span className="ml-auto text-muted-foreground/60">
              {contextWindowEstimated ? "≈" : ""}
              {pct(contextWindowFraction)} of context window
              {contextWindowEstimated ? " (estimated)" : ""}
            </span>
          )}
          {!windowKnown && (
            <span className="ml-auto text-muted-foreground/60">
              proportions only — context window size unknown
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
