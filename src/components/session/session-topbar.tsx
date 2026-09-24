"use client";

import { Button } from "@/components/ui/button";
import { useContextInspections } from "@/hooks/use-context-check";
import type { CodeMap } from "@/lib/code-map/types";
import {
  ClipboardListIcon,
  GitCompareIcon,
  LayoutPanelLeftIcon,
  LayoutPanelTopIcon,
  NetworkIcon,
  ScanSearchIcon,
  SettingsIcon,
} from "lucide-react";
import { useState } from "react";
import { GoalEditor } from "./goal-editor";
import { CodeMapPanel } from "../conversation/code-map-panel";
import { InspectorPanel } from "../session-panels/inspector-panel";
import { GlobalCostBadge, SessionProjectBadges } from "./header-actions";
import { SidebarTrigger } from "../ui/sidebar";
import { ProjectsCombobox } from "../sidebar/projects-combobox";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import Link from "next/link";

interface SessionTopbarProps {
  /** Toggle the review panel. Absent when the session cannot be reviewed. */
  onReviewClick?: () => void;
  /** Toggle the session summary card beside the conversation. */
  onSummaryClick?: () => void;
  /** The summary card is showing, so its button reads as active. */
  summaryOpen?: boolean;
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
  sessionId,
  goal,
  onGoalSave,
  onReviewClick,
  onSummaryClick,
  summaryOpen = false,
  reviewCount = 0,
  reviewOpen = false,
  reviewLayout,
  onReviewLayoutChange,
}: SessionTopbarProps) {
  const [panelMode, setPanelMode] = useState<PanelMode>(null);

  function togglePanel(mode: PanelMode) {
    setPanelMode((prev) => (prev === mode ? null : mode));
  }

  return (
    <>
      {/* Title bar. Parked above the viewport until the pointer reaches the
          top edge: a fully translated bar has no hit target of its own, so
          the short strip stays in place and the bar slides down over it.
          The leave delay covers the moment the pointer moves from that strip
          onto the bar while it is still traveling. */}
      <div className="group/topbar relative z-40 h-1 w-full shrink-0">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-border/70"
        />
        <div className="inset-x-0 top-0 flex h-8 items-center gap-2 border-b border-border/40 bg-background px-2 shadow-sm transition-transform duration-200 ease-out -translate-y-full delay-300 group-hover/topbar:translate-y-0 group-hover/topbar:delay-0 group-focus-within/topbar:translate-y-0 group-focus-within/topbar:delay-0 group-has-data-popup-open/topbar:translate-y-0 group-has-data-popup-open/topbar:delay-0">
          <SidebarTrigger />
          <ProjectsCombobox small />
          {sessionId && <SessionProjectBadges sessionId={sessionId} />}
          {/* Left: goal */}
          {onGoalSave && (
            <div className="max-w-lg items-center justify-items-center">
              <GoalEditor
                goal={goal ?? null}
                onSave={onGoalSave}
                variant="inline"
              />
            </div>
          )}

          {/* Center: session title */}
          <div className="flex min-w-0 flex-1 justify-center">
            <h1 className="max-w-300 truncate text-xs font-medium text-foreground">
              {title ?? "Untitled session"}
            </h1>
          </div>

          {/* Right: controls */}
          <div className="flex shrink-0 items-center">
            {/* Review — always offered, so a dismissed panel is never a dead end */}
            {onReviewClick && (
              <Button
                onClick={onReviewClick}
                size="xs"
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

            {/* Summary — always offered, same reasoning as Review above: a
              panel the operator closed must stay reachable. */}
            {onSummaryClick && (
              <Button
                onClick={onSummaryClick}
                size="xs"
                title="What this session is for, cost, and what it produced"
                variant={summaryOpen ? "secondary" : "ghost"}
              >
                <ClipboardListIcon />
                Summary
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
              size="xs"
              variant={panelMode === "inspector" ? "secondary" : "ghost"}
              onClick={() => togglePanel("inspector")}
            >
              <ContextQualityDot sessionId={sessionId} />
              <ScanSearchIcon />
              Inspect
            </Button>

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
                  <LayoutPanelLeftIcon size={16} />
                ) : (
                  <LayoutPanelTopIcon size={16} />
                )}
              </Button>
            )}

            <div className="flex items-center gap-3 text-xs text-foreground">
              <Popover>
                <PopoverTrigger
                  closeDelay={0}
                  delay={0}
                  openOnHover
                  render={<div className={`flex p-2`} />}
                >
                  <SettingsIcon size={16} />
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  className="w-auto min-w-64 px-4 py-2.5"
                  side="bottom"
                  sideOffset={0}
                >
                  <GlobalCostBadge />
                  <Link href="/settings">Settings</Link>
                </PopoverContent>
              </Popover>
            </div>
          </div>
        </div>

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
      </div>
    </>
  );
}
