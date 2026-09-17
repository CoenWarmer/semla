"use client";

/**
 * The scrubber: step through what the agent did to answer a prompt.
 *
 * A pill rather than a list, because the interesting thing about a turn's work
 * is its *order* — what the agent did, and what it did next. A list of forty
 * tool calls sorted by name answers a different question, and the transcript
 * already answers it badly.
 *
 * It is literally a pill now: fully rounded, inset from the panel's edges, and
 * carrying the same green as the follow-the-agent glow — one variable, so the
 * bar and the glow cannot drift apart. That green is a saturated mid-tone, so
 * every control inside it is repainted against it rather than against the
 * theme background: text is `--semla-following-foreground`, and the chips,
 * borders and hover states are translucent black over the green instead of
 * `muted`/`accent`, which would read as grey patches on a green field.
 *
 * The unit is a tool call, not a file: a call that touched one or more files
 * shows a `tool: <name>` badge plus one badge per file, grouped together and
 * independently clickable; a call that touched none is a single stop with no
 * file badge, visible only under the "All tools" filter.
 *
 * Holds only its own cursor. Which file is open is the panel's business, so a
 * step is an event handler that calls up rather than state this component and
 * the panel both keep and have to agree about.
 */

import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CrosshairIcon,
  FileSearchIcon,
  PencilIcon,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  buildSequence,
  clampIndex,
  rangeLabel,
  siblingsOf,
  stepIndex,
  type ScrubberStop,
} from "@/lib/pi/file-access/access-sequence";
import {
  LIVE_TURN_ID,
  type AccessAgent,
  type ToolCallStep,
  type TimelineTurn,
} from "@/lib/pi/file-access/access-types";
import { cn } from "@/lib/utils";

export type ScrubberScope = "turn" | "session";

const basename = (path: string) => path.split("/").pop() ?? path;

/**
 * The turn to scope to.
 *
 * A running turn's calls arrive live, before anything is persisted, so they
 * are attributed to `LIVE_TURN_ID` and are not in `turns` yet. While any are
 * present that *is* the current turn — scoping to the last persisted one would
 * show the previous prompt's work while the agent is working.
 */
const latestTurn = (
  turns: readonly TimelineTurn[],
  calls: readonly ToolCallStep[],
) =>
  calls.some((call) => call.turnId === LIVE_TURN_ID)
    ? LIVE_TURN_ID
    : (turns[turns.length - 1]?.id ?? null);

/** The `tool: <name>` badge shown for every stop's group, file or not. */
function ToolPill({ call }: { call: ToolCallStep }) {
  const label = (
    <span
      className={cn(
        "shrink-0 truncate rounded-full bg-black/10 px-2 py-0.5 font-mono text-[11px]",
        // On green, `text-destructive` at 15% opacity is not a failure
        // signal — it is a slightly different green. A solid fill is.
        call.isError && "bg-destructive text-white",
      )}
    >
      tool: {call.name}
    </span>
  );

  if (!call.summary && !call.isError) return label;

  return (
    <Tooltip>
      <TooltipTrigger render={<span />}>{label}</TooltipTrigger>
      <TooltipContent>
        {call.isError ? "This call failed. " : ""}
        {call.summary ?? ""}
      </TooltipContent>
    </Tooltip>
  );
}

/** One file badge within a tool call's group — same styling for every file it touched. */
function FileBadge({
  active,
  onClick,
  stop,
}: {
  active: boolean;
  onClick: () => void;
  stop: Extract<ScrubberStop, { kind: "file" }>;
}) {
  const { access } = stop;
  const label = rangeLabel(stop);

  return (
    <button
      className={cn(
        "flex min-w-0 shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs transition-colors",
        // The active badge is the *lightest* thing in the bar rather than the
        // darkest: `accent` is near-black here, and a black chip on green
        // reads as a hole punched in the pill.
        active
          ? "bg-white/85 text-semla-following-foreground"
          : "text-semla-following-foreground/75 hover:bg-black/10 hover:text-semla-following-foreground",
      )}
      onClick={onClick}
      title={`${access.project ? `${access.project}/` : ""}${access.path}`}
      type="button"
    >
      {access.kind === "write" ? (
        <PencilIcon className="size-3 shrink-0" />
      ) : (
        <FileSearchIcon className="size-3 shrink-0" />
      )}
      <span className="truncate font-medium">{basename(access.path)}</span>
      {label ? (
        <span className="shrink-0 tabular-nums opacity-70">{label}</span>
      ) : null}
      {/* A shell-derived path is a guess. Saying so is the difference
          between a scrubber that is sometimes wrong and one that lies. */}
      {access.confidence === "inferred" ? (
        <Tooltip>
          {/* `render` rather than children: TooltipTrigger renders its own
              <button> by default, and this sits inside one already. */}
          <TooltipTrigger
            render={
              <span className="shrink-0 rounded-full bg-amber-100 px-1.5 text-[10px] text-amber-900" />
            }
          >
            ~
          </TooltipTrigger>
          <TooltipContent>
            Parsed out of a shell command, so the file and lines are inferred
            rather than read from a tool argument.
          </TooltipContent>
        </Tooltip>
      ) : null}
    </button>
  );
}

export function ReviewScrubber({
  agents,
  calls,
  following,
  onFollowingChange,
  onStep,
  turns,
}: {
  agents: readonly AccessAgent[];
  calls: readonly ToolCallStep[];
  following: boolean;
  onFollowingChange: (following: boolean) => void;
  /** Open this stop. The panel owns which file is showing. */
  onStep: (stop: ScrubberStop) => void;
  turns: readonly TimelineTurn[];
}) {
  const [scope, setScope] = useState<ScrubberScope>("turn");
  const [agentId, setAgentId] = useState<string | null>(null);
  /** "File tools" (the historic scope) unless the operator opts into everything. */
  const [showAllTools, setShowAllTools] = useState(false);
  /**
   * Where the arrows are. Null means "not started" and shows the first stop's
   * number without having navigated anywhere, so opening the panel does not
   * yank the editor off whatever the operator was reading.
   */
  const [cursor, setCursor] = useState<number | null>(null);

  const sequence = useMemo(
    () =>
      buildSequence(calls, {
        agentId,
        showAllTools,
        turnId: scope === "turn" ? latestTurn(turns, calls) : null,
      }),
    [agentId, calls, scope, showAllTools, turns],
  );

  const { missing, stops, unlinked } = sequence;
  const skipped = missing + unlinked;
  // Derived, never pushed into `cursor` as the events arrive: that would be
  // the `react/set-state-in-effect` this repository treats as an error, and it
  // would give the counter a second source of truth to disagree with.
  const index = stepIndex({ cursor, following, length: stops.length });
  const current = stops[index];
  const group = current ? siblingsOf(stops, index) : null;

  const go = useCallback(
    (next: number) => {
      const clamped = clampIndex(next, stops.length);
      const stop = stops[clamped];
      if (!stop) return;

      setCursor(clamped);
      // Unpinning from the agent is left to `onStep`'s handler. Doing it here
      // too would conflate "I stepped away for now" with the Follow button's
      // saved preference, and an arrow press would turn following off for
      // every future session.
      onStep(stop);
    },
    [onStep, stops],
  );

  // Nothing this session ever did, in any filter state — as opposed to
  // nothing under the *current* one, which still renders the bar so the "All
  // tools" toggle that would reveal it stays reachable.
  if (calls.length === 0) return null;

  return (
    // `m-2` rather than a full-width bar: a pill with square ends touching
    // the panel's edges is not a pill. The margin is what makes the shape
    // legible, and `rounded-full` is what makes it one.
    <div className="m-2 flex shrink-0 items-center gap-2 rounded-full bg-semla-following px-3 py-1.5 text-semla-following-foreground">
      <div className="flex items-center gap-0.5">
        <Button
          aria-label="Previous step"
          className="rounded-full text-semla-following-foreground hover:bg-black/10 hover:text-semla-following-foreground"
          disabled={index <= 0 || stops.length === 0}
          onClick={() => go(index - 1)}
          size="icon"
          variant="ghost"
        >
          <ChevronLeftIcon className="size-4" />
        </Button>
        <Button
          aria-label="Next step"
          className="rounded-full text-semla-following-foreground hover:bg-black/10 hover:text-semla-following-foreground"
          disabled={index >= stops.length - 1 || stops.length === 0}
          onClick={() => go(index + 1)}
          size="icon"
          variant="ghost"
        >
          <ChevronRightIcon className="size-4" />
        </Button>
      </div>

      <span className="text-xs tabular-nums text-semla-following-foreground/80">
        {stops.length === 0 ? 0 : index + 1} / {stops.length}
      </span>

      {current && group ? (
        <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
          <ToolPill call={current.call} />
          {current.kind === "file"
            ? stops.slice(group.start, group.end + 1).map((stop, offset) => {
                if (stop.kind !== "file") return null;
                const globalIndex = group.start + offset;
                return (
                  <FileBadge
                    active={globalIndex === index}
                    key={stop.id}
                    onClick={() => go(globalIndex)}
                    stop={stop}
                  />
                );
              })
            : null}
        </div>
      ) : (
        <span className="text-xs text-semla-following-foreground/80">
          {skipped > 0
            ? "No files the agent opened are still on disk."
            : "Nothing to show under this filter."}
        </span>
      )}

      <div className="ml-auto flex shrink-0 items-center gap-1">
        {skipped > 0 ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="text-xs text-semla-following-foreground/80" />
              }
            >
              {skipped} skipped
            </TooltipTrigger>
            <TooltipContent>
              The arrows skip{" "}
              {missing > 0 ? `${missing} no longer on disk` : ""}
              {missing > 0 && unlinked > 0 ? " and " : ""}
              {unlinked > 0
                ? `${unlinked} outside this session's projects`
                : ""}
              , because neither can be opened here.
            </TooltipContent>
          </Tooltip>
        ) : null}

        {agents.length > 1 ? (
          <select
            aria-label="Filter by agent"
            className="rounded-full border border-black/20 bg-black/10 px-2 py-0.5 text-xs text-semla-following-foreground"
            onChange={(event) => {
              setAgentId(event.target.value === "" ? null : event.target.value);
              setCursor(null);
            }}
            value={agentId ?? ""}
          >
            <option value="">All agents</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.label}
              </option>
            ))}
          </select>
        ) : null}

        <button
          className="rounded-full border border-black/20 px-2 py-0.5 text-xs text-semla-following-foreground/85 transition-colors hover:bg-black/10 hover:text-semla-following-foreground"
          onClick={() => {
            setShowAllTools((previous) => !previous);
            setCursor(null);
          }}
          type="button"
        >
          {showAllTools ? "All tools" : "File tools"}
        </button>

        <button
          className="rounded-full border border-black/20 px-2 py-0.5 text-xs text-semla-following-foreground/85 transition-colors hover:bg-black/10 hover:text-semla-following-foreground"
          onClick={() => {
            setScope((previous) => (previous === "turn" ? "session" : "turn"));
            setCursor(null);
          }}
          type="button"
        >
          {scope === "turn" ? "This turn" : "Whole session"}
        </button>

        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label="Follow the agent"
                aria-pressed={following}
                className={cn(
                  "rounded-full text-semla-following-foreground hover:bg-black/10 hover:text-semla-following-foreground",
                  // Pressed reads as white-on-green, the same inversion the
                  // active file badge uses, so "on" means one thing in the bar.
                  following &&
                    "bg-white/85 hover:bg-white/85 text-semla-following-foreground",
                )}
                onClick={() => {
                  // Unfollowing leaves the cursor on the stop the agent
                  // reached, matching the file the panel keeps open. Without
                  // it the counter would snap back to wherever the arrows were
                  // last used, naming a file that is not on screen.
                  if (following) setCursor(index);
                  onFollowingChange(!following);
                }}
                size="icon"
                variant="ghost"
              />
            }
          >
            <CrosshairIcon className="size-4" />
          </TooltipTrigger>
          <TooltipContent>
            {following
              ? "Following the agent — the editor opens each file as it is read."
              : "Follow the agent as it reads and writes."}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
