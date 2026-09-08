"use client";

import { Button } from "@/components/ui/button";
import { useSessionCost } from "@/hooks/use-session-cost";
import { useContextInspections } from "@/hooks/use-context-check";
import type {
  SessionMessage,
  SessionToolCall,
} from "@/hooks/use-session-messages";
import type { CodeMap } from "@/lib/code-map/types";
import { sessionComposition } from "@/lib/context-composition";
import {
  GitCompareIcon,
  LayoutPanelLeftIcon,
  LayoutPanelTopIcon,
  NetworkIcon,
  ScanSearchIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { GoalEditor } from "./goal-editor";
import { CodeMapPanel } from "../conversation/code-map-panel";
import { InspectorPanel } from "../session-panels/inspector-panel";

import { TokenUsage } from "../token-usage";
import { SessionContextWindowBar } from "./session-context-window-bar";

interface SessionTopbarProps {
  /** Toggle the review panel. Absent when the session cannot be reviewed. */
  onReviewClick?: () => void;
  /** Changed files waiting to be reviewed, for the button's badge. */
  reviewCount?: number;
  /** The review overlay is open, so the button reads as active. */
  reviewOpen?: boolean;
  /**
   * Which way the review panel splits from the conversation. Absent hides
   * the split-direction control — there is nothing to orient while the
   * panel is closed.
   */
  reviewLayout?: "horizontal" | "vertical";
  onReviewLayoutChange?: (layout: "horizontal" | "vertical") => void;
  title: string | null;
  /** Latest map the code_map tool drew in this session, if any. */
  codeMap?: CodeMap;
  sessionId: string;
  goal?: string | null;
  onGoalSave?: (goal: string | null) => Promise<void>;
  messages: SessionMessage[];
  /** Model context window, from the transcript response. */
  contextWindow: number | null;
  /** Cache-read cost rate in $/M tokens, from the transcript response. */
  cacheReadRatePerMToken?: number | null;
  /** Size of this session's system prompt, from the transcript response. */
  systemPromptChars?: number;
  sessionRunning?: boolean;
  onCompactClick?: () => void;
  toolCalls?: SessionToolCall[];
}

/** The panels the title bar still owns. "agents" and "branches" moved to the bottom bar. */
type PanelMode = "codemap" | "inspector" | null;

function ContextQualityDot({ sessionId }: { sessionId: string }) {
  const { data: inspections } = useContextInspections(sessionId);
  const latest = inspections?.[0];
  if (!latest) return null;

  const colors: Record<string, string> = {
    good: "bg-green-500",
    warning: "bg-yellow-500",
    degraded: "bg-destructive",
  };
  const dot = colors[latest.result.quality] ?? "bg-muted";
  return (
    <span
      className={`size-2 rounded-full shrink-0 ${dot}`}
      title={latest.result.summary}
    />
  );
}

export function SessionTopbar({
  title,
  codeMap,
  contextWindow,
  cacheReadRatePerMToken,
  systemPromptChars,
  sessionId,
  goal,
  onGoalSave,
  messages,
  sessionRunning,
  onReviewClick,
  onCompactClick,
  reviewCount = 0,
  reviewOpen = false,
  reviewLayout,
  onReviewLayoutChange,
  toolCalls,
}: SessionTopbarProps) {
  const [panelMode, setPanelMode] = useState<PanelMode>(null);
  const { cost: totalCost, tokens: totalTokens } = useSessionCost(sessionId);
  // Computed here rather than fetched. It is arithmetic over the transcript
  // this component already has; asking a route for it meant the server
  // re-reading and re-parsing the whole session to return numbers the browser
  // was holding all along.
  const composition = useMemo(
    () =>
      sessionComposition({
        contextWindow,
        cacheReadRatePerMToken,
        messages,
        systemPromptChars: systemPromptChars ?? 0,
        toolCalls: toolCalls ?? [],
      }),
    [
      cacheReadRatePerMToken,
      contextWindow,
      messages,
      systemPromptChars,
      toolCalls,
    ],
  );

  function togglePanel(mode: PanelMode) {
    setPanelMode((prev) => (prev === mode ? null : mode));
  }

  return (
    <>
      {/* Title bar */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/40 px-6">
        {/* Left: session title */}
        <h1 className="max-w-300 truncate text-sm font-medium text-foreground">
          {title ?? "Untitled session"}
        </h1>

        {/* Center: goal */}
        <div className="flex min-w-0 flex-1 justify-center">
          {onGoalSave && (
            <div className="w-full max-w-lg items-center justify-items-center">
              <GoalEditor
                goal={goal ?? null}
                onSave={onGoalSave}
                variant="inline"
              />
            </div>
          )}
        </div>

        {/* Right: controls */}
        <div className="flex shrink-0 items-center gap-2">
          {/* Review — always offered, so a dismissed panel is never a dead end */}
          {onReviewClick && (
            <Button
              onClick={onReviewClick}
              size="sm"
              title="Review the changes in this session's projects"
              variant={reviewOpen ? "secondary" : "ghost"}
            >
              <GitCompareIcon />
              Review
              {reviewCount > 0 && (
                <span className="rounded bg-primary/15 px-1 text-[10px] font-medium tabular-nums">
                  {reviewCount}
                </span>
              )}
            </Button>
          )}

          {/* Only meaningful while the review panel is actually split against
              the conversation. */}
          {reviewOpen && onReviewLayoutChange && (
            <Button
              onClick={() =>
                onReviewLayoutChange(
                  reviewLayout === "vertical" ? "horizontal" : "vertical",
                )
              }
              size="icon"
              title={
                reviewLayout === "vertical"
                  ? "Switch to side-by-side"
                  : "Switch to stacked"
              }
              variant="ghost"
            >
              {reviewLayout === "vertical" ? (
                <LayoutPanelLeftIcon />
              ) : (
                <LayoutPanelTopIcon />
              )}
            </Button>
          )}

          {/* Code map — only offered once there is one to show */}
          {codeMap && (
            <Button
              size="sm"
              variant={panelMode === "codemap" ? "secondary" : "ghost"}
              onClick={() => togglePanel("codemap")}
              title="Show the call graph Semla resolved"
            >
              <NetworkIcon />
              Map
            </Button>
          )}

          {/* Inspect — opens context inspector panel */}
          <Button
            size="sm"
            variant={panelMode === "inspector" ? "secondary" : "ghost"}
            onClick={() => togglePanel("inspector")}
          >
            <ContextQualityDot sessionId={sessionId} />
            <ScanSearchIcon />
            Inspect
          </Button>

          <div className="flex items-center gap-3 text-xs text-foreground">
            <TokenUsage cost={totalCost} tokens={totalTokens} />
          </div>
        </div>
      </div>
      <SessionContextWindowBar
        composition={composition}
        sessionRunning={sessionRunning}
        onCompactClick={onCompactClick}
      />

      {panelMode === "codemap" && (
        <div
          className="shrink-0 border-b border-border/40 overflow-hidden p-3"
          style={{ height: 353 }}
        >
          <CodeMapPanel map={codeMap} />
        </div>
      )}

      {panelMode === "inspector" && (
        <div
          className="shrink-0 border-b border-border/40 overflow-hidden px-3"
          style={{ height: 353 }}
        >
          <InspectorPanel goal={goal} sessionId={sessionId} />
        </div>
      )}
    </>
  );
}
