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
 *
 * Each phase box is a CONTAINER whose border stays visible, with one inset
 * slice per agent drawn inside it. Phase boxes keep equal widths (`flex-1`)
 * regardless of agent count, deliberately: a busy phase's slices get thinner
 * instead of the phase boundaries shifting every time any agent anywhere is
 * created. Because a sequential phase's agents come into existence one at a
 * time (see `WorkflowPhaseSegment.agents`), those inner slices re-divide as
 * the run proceeds — equal outer widths keep that churn contained to the one
 * phase it belongs to.
 *
 * EVERY run the session has gets a row, stacked oldest-first with a name
 * label, rather than only the most recent one. `deriveWorkflowRunRows` owns
 * that ordering and the phaseless-run fallback, and its docblock has the
 * reasoning; this component only lays the rows out.
 */

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatCost, formatTokens } from "@/components/token-usage";
import { cn } from "@/lib/utils";
import {
  agentSliceStatusLabel,
  phaseStatusLabel,
  type WorkflowAgentSliceStatus,
  type WorkflowPhaseAgentSlice,
  type WorkflowPhaseSegment,
} from "@/lib/workflow-phase-progress";
import {
  deriveWorkflowRunRows,
  type WorkflowRunRow,
} from "@/lib/workflow-run-rows";
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

/** The shimmer a running bar animates, shared by phase boxes and agent slices. */
const RUNNING_STYLE = {
  animation: "workflow-phase-shimmer 1.6s linear infinite",
  background:
    "linear-gradient(90deg, var(--color-primary) 25%, rgba(255,255,255,0.55) 50%, var(--color-primary) 75%)",
  backgroundSize: "200% 100%",
} as const;

/**
 * Fill for one agent slice. `error` and `skipped` are the two outcomes a phase
 * bar has to collapse into "done" — an agent slice keeps them, which is most
 * of the point of drawing agents at all.
 */
function sliceFillClass(status: WorkflowAgentSliceStatus): string {
  switch (status) {
    case "done":
      return "bg-primary/70";
    case "error":
      return "bg-destructive/70";
    case "skipped":
      return "bg-muted-foreground/30";
    case "planned":
      return "bg-muted/40 opacity-50";
    case "running":
      // Painted by RUNNING_STYLE instead; no static fill.
      return "";
  }
}

/**
 * One agent's slice. Carries its phase's title in its own tooltip because the
 * phase container deliberately is NOT a tooltip trigger — a `TooltipTrigger`
 * nested inside another opens both on a single hover, so the phase name rides
 * along here instead.
 */
function AgentSlice({
  phaseTitle,
  slice,
}: {
  phaseTitle: string;
  slice: WorkflowPhaseAgentSlice;
}) {
  const isRunning = slice.status === "running";

  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={`${phaseTitle} – ${slice.label}: ${agentSliceStatusLabel(slice.status)}`}
        className={cn("h-full min-w-px flex-1 rounded-[1px]", sliceFillClass(slice.status))}
        style={isRunning ? RUNNING_STYLE : undefined}
        type="button"
      />
      <TooltipContent>
        <div className="flex flex-col gap-0.5">
          <span className="text-muted-foreground text-xs">{phaseTitle}</span>
          <span className="font-medium">{slice.label}</span>
          <span>{agentSliceStatusLabel(slice.status)}</span>
          {slice.model ? (
            <span className="text-muted-foreground">{slice.model}</span>
          ) : null}
          {slice.tokens ? (
            <span className="text-muted-foreground">
              {formatTokens(slice.tokens)} tokens
              {slice.cost ? ` · ${formatCost(slice.cost)}` : ""}
            </span>
          ) : null}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

function SegmentBox({ segment }: { segment: WorkflowPhaseSegment }) {
  const isRunning = segment.status === "running";
  const isPlanned = segment.status === "planned";
  // A phase with no agents yet renders as one solid bar in its own phase
  // status — there are no slices to draw, and an empty container would read
  // as missing data rather than as "not reached".
  const hasSlices = segment.agents.length > 0;

  if (!hasSlices) {
    return (
      <Tooltip>
        <TooltipTrigger
          aria-label={`${segment.title}: ${phaseStatusLabel(segment.status)}`}
          className={cn(
            "h-3 flex-1 rounded-sm border border-border/40",
            isPlanned ? "bg-muted/40 opacity-50" : "bg-primary/70",
          )}
          style={isRunning ? RUNNING_STYLE : undefined}
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

  // The phase box becomes a purely presentational container: its border is
  // what keeps the phase boundary legible once the interior is subdivided, so
  // it is drawn on this element and never on the slices. It is neither a
  // tooltip trigger nor a labelled group — a nested TooltipTrigger would open
  // two tooltips per hover (see AgentSlice), and each slice's own aria-label
  // already names this phase, so a label here would only repeat it.
  return (
    <div className="flex h-3 flex-1 items-stretch gap-px rounded-sm border border-border/40 bg-muted/20 p-px">
      {segment.agents.map((slice) => (
        <AgentSlice key={slice.id} phaseTitle={segment.title} slice={slice} />
      ))}
    </div>
  );
}

/**
 * One run: its name, then its phase (or whole-run) segments.
 *
 * The label is a fixed-width column rather than an inline flex item so the
 * bars of every row start at the same x, which is what makes a stack of runs
 * readable as a stack. It truncates instead of wrapping, since a workflow name
 * is generated from the script's `meta.name` and can be long — so its tooltip
 * carries the full name as well as the run's spend, and is the only place a
 * truncated name can be read in full.
 */
function RunRow({ row }: { row: WorkflowRunRow }) {
  return (
    <div className="flex w-full items-center gap-2">
      <Tooltip>
        <TooltipTrigger className="w-28 shrink-0 truncate text-left text-[10px] text-muted-foreground">
          {row.name}
        </TooltipTrigger>
        <TooltipContent>
          <div className="flex flex-col gap-0.5">
            <span className="font-medium">{row.name}</span>
            {row.usage ? (
              <>
                <span>
                  {formatTokens(row.usage.tokens)} tokens ·{" "}
                  {formatCost(row.usage.cost)}
                </span>
                {/*
                  A live run's total is still climbing. Saying so is the point:
                  without it the number reads as what the run cost, which it is
                  not yet.
                */}
                {row.usage.partial ? (
                  <span className="text-muted-foreground">so far — run in progress</span>
                ) : null}
              </>
            ) : (
              // Distinct from "$0.000": nothing has reported usage yet, which
              // is not the same as a run that spent nothing.
              <span className="text-muted-foreground">No usage reported yet</span>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
      <div className="flex min-w-0 flex-1 items-center gap-1">
        {row.segments.map((segment) => (
          <SegmentBox key={segment.title} segment={segment} />
        ))}
      </div>
    </div>
  );
}

export function WorkflowPhaseBar({
  runs,
  snapshot,
}: {
  /**
   * Every run the session has, newest first, as the workflows API returns
   * them. Omitted or empty falls back to `snapshot` alone, which is what keeps
   * a caller that has no run list (and the component's own tests) working.
   */
  runs?: readonly (WorkflowSnapshot | null | undefined)[] | null;
  /** The live in-flight run, when there is one. */
  snapshot: WorkflowSnapshot | null | undefined;
}) {
  const rows = deriveWorkflowRunRows(runs, snapshot);
  if (rows.length === 0) return null;

  return (
    <TooltipProvider>
      <style>{PHASE_SHIMMER_STYLE}</style>
      <div className="flex w-full flex-col gap-1">
        {rows.map((row) => (
          <RunRow key={row.key} row={row} />
        ))}
      </div>
    </TooltipProvider>
  );
}
