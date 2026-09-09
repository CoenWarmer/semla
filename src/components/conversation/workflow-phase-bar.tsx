"use client";

/**
 * A segmented progress bar for a workflow run's phases, rendered inline in
 * the conversation so the user can see how far along a multi-phase run is
 * without opening the workflow panel.
 *
 * Status per segment is derived, not read — see
 * `src/lib/workflow-phase-progress.ts` for why the snapshot alone cannot say
 * "done" versus "skipped", and why that derivation lives in its own
 * React-free module. This component is intentionally thin: it turns segments
 * into boxes and wires up the tooltip.
 *
 * The running-segment animation reuses the shimmer convention from
 * `session-workflow-panel.tsx`'s `SpanBar` (a `background-position`
 * keyframe over a three-stop gradient) rather than inventing a new one.
 */

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  deriveWorkflowPhaseProgress,
  phaseStatusLabel,
  type WorkflowPhaseSegment,
} from "@/lib/workflow-phase-progress";
import type { WorkflowSnapshot } from "@/types/workflow";

// Same keyframe name/shape as SpanBar's SHIMMER_STYLE in
// session-workflow-panel.tsx. Injected here too (scoped by the `@keyframes`
// name being idempotent to redefine) rather than importing across component
// boundaries for one style string.
const PHASE_SHIMMER_STYLE = `
@keyframes workflow-phase-shimmer {
  0%   { background-position: 200% center; }
  100% { background-position: -200% center; }
}
`;

function agentCountLabel(count: number): string {
  if (count === 1) return `1 agent`;
  return `${count} agents`;
}

function SegmentBox({ segment }: { segment: WorkflowPhaseSegment }) {
  const isRunning = segment.status === "running";
  const isPlanned = segment.status === "planned";

  return (
    <Tooltip>
      <TooltipTrigger
        className={cn(
          "h-2 flex-1 rounded-sm border border-border/40",
          isPlanned ? "bg-muted/40 opacity-50" : "bg-primary/70",
        )}
        style={
          isRunning
            ? {
                animation: "workflow-phase-shimmer 1.6s linear infinite",
                background:
                  "linear-gradient(90deg, var(--color-primary) 25%, rgba(255,255,255,0.55) 50%, var(--color-primary) 75%)",
                backgroundSize: "200% 100%",
              }
            : undefined
        }
        type="button"
      />
      <TooltipContent>
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">{segment.title}</span>
          <span>{phaseStatusLabel(segment.status)}</span>
          <span>{agentCountLabel(segment.agentCount)}</span>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

export function WorkflowPhaseBar({
  snapshot,
}: {
  snapshot: WorkflowSnapshot | null | undefined;
}) {
  const segments = deriveWorkflowPhaseProgress(snapshot);
  if (!segments) return null;

  return (
    <TooltipProvider>
      <style>{PHASE_SHIMMER_STYLE}</style>
      <div className="flex w-full items-center gap-1">
        {segments.map((segment) => (
          <SegmentBox key={segment.title} segment={segment} />
        ))}
      </div>
    </TooltipProvider>
  );
}
