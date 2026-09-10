"use client";

/**
 * The scrubber: step through the files the agent read and wrote to answer a
 * prompt.
 *
 * A pill rather than a list, because the interesting thing about a turn's reads
 * is their *order* — what the agent looked at, and what it looked at next. A
 * list of forty file names sorted by path answers a different question, and the
 * transcript already answers it badly.
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
  stepIndex,
  type AccessStep,
} from "@/lib/pi/file-access/access-sequence";
import {
  LIVE_TURN_ID,
  type AccessAgent,
  type FileAccess,
  type TimelineTurn,
} from "@/lib/pi/file-access/access-types";
import { cn } from "@/lib/utils";

export type ScrubberScope = "turn" | "session";

const basename = (path: string) => path.split("/").pop() ?? path;

/**
 * The turn to scope to.
 *
 * A running turn's accesses arrive live, before anything is persisted, so they
 * are attributed to `LIVE_TURN_ID` and are not in `turns` yet. While any are
 * present that *is* the current turn — scoping to the last persisted one would
 * show the previous prompt's reads while the agent is working.
 */
const latestTurn = (
  turns: readonly TimelineTurn[],
  accesses: readonly FileAccess[],
) =>
  accesses.some((access) => access.turnId === LIVE_TURN_ID)
    ? LIVE_TURN_ID
    : (turns[turns.length - 1]?.id ?? null);

export function ReviewScrubber({
  accesses,
  agents,
  following,
  onFollowingChange,
  onStep,
  selection,
  turns,
}: {
  accesses: readonly FileAccess[];
  agents: readonly AccessAgent[];
  following: boolean;
  onFollowingChange: (following: boolean) => void;
  /** Open this stop. The panel owns which file is showing. */
  onStep: (step: AccessStep) => void;
  /** What the panel is showing, so the pill can mark the matching stop. */
  selection: { project: string | null; path: string } | null;
  turns: readonly TimelineTurn[];
}) {
  const [scope, setScope] = useState<ScrubberScope>("turn");
  const [agentId, setAgentId] = useState<string | null>(null);
  /**
   * Where the arrows are. Null means "not started" and shows the first stop's
   * number without having navigated anywhere, so opening the panel does not
   * yank the editor off whatever the operator was reading.
   */
  const [cursor, setCursor] = useState<number | null>(null);

  const sequence = useMemo(
    () =>
      buildSequence(accesses, {
        agentId,
        turnId: scope === "turn" ? latestTurn(turns, accesses) : null,
      }),
    [accesses, agentId, scope, turns],
  );

  const { missing, steps, unlinked } = sequence;
  const skipped = missing + unlinked;
  // Derived, never pushed into `cursor` as the events arrive: that would be
  // the `react/set-state-in-effect` this repository treats as an error, and it
  // would give the counter a second source of truth to disagree with.
  const index = stepIndex({ cursor, following, length: steps.length });
  const current = steps[index];

  const go = useCallback(
    (next: number) => {
      const clamped = clampIndex(next, steps.length);
      const step = steps[clamped];
      if (!step) return;

      setCursor(clamped);
      // Unpinning from the agent is left to `onStep`'s handler. Doing it here
      // too would conflate "I stepped away for now" with the Follow button's
      // saved preference, and an arrow press would turn following off for
      // every future session.
      onStep(step);
    },
    [onStep, steps],
  );

  if (steps.length === 0 && skipped === 0) return null;

  const showing =
    current !== undefined &&
    selection?.path === current.path &&
    selection.project === current.project;

  return (
    <div className="flex shrink-0 items-center gap-2 border-b bg-muted/30 px-3 py-1.5">
      <div className="flex items-center gap-0.5">
        <Button
          aria-label="Previous file the agent opened"
          disabled={index <= 0 || steps.length === 0}
          onClick={() => go(index - 1)}
          size="icon"
          variant="ghost"
        >
          <ChevronLeftIcon className="size-4" />
        </Button>
        <Button
          aria-label="Next file the agent opened"
          disabled={index >= steps.length - 1 || steps.length === 0}
          onClick={() => go(index + 1)}
          size="icon"
          variant="ghost"
        >
          <ChevronRightIcon className="size-4" />
        </Button>
      </div>

      <span className="text-xs tabular-nums text-muted-foreground">
        {steps.length === 0 ? 0 : index + 1} / {steps.length}
      </span>

      {current ? (
        <button
          className={cn(
            "flex min-w-0 items-center gap-1.5 rounded px-1.5 py-0.5 text-xs transition-colors",
            showing
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => go(index)}
          title={`${current.project ? `${current.project}/` : ""}${current.path}`}
          type="button"
        >
          {current.kind === "write" ? (
            <PencilIcon className="size-3 shrink-0" />
          ) : (
            <FileSearchIcon className="size-3 shrink-0" />
          )}
          <span className="truncate font-medium">{basename(current.path)}</span>
          {rangeLabel(current) ? (
            <span className="shrink-0 tabular-nums opacity-70">
              {rangeLabel(current)}
            </span>
          ) : null}
          {current.count > 1 ? (
            <span className="shrink-0 opacity-70">×{current.count}</span>
          ) : null}
          {/* A shell-derived path is a guess. Saying so is the difference
              between a scrubber that is sometimes wrong and one that lies. */}
          {current.confidence === "inferred" ? (
            <Tooltip>
              {/* `render` rather than children: TooltipTrigger renders its own
                  <button> by default, and this sits inside one already. */}
              <TooltipTrigger
                render={
                  <span className="shrink-0 rounded bg-amber-500/15 px-1 text-[10px] text-amber-600 dark:text-amber-400" />
                }
              >
                ~
              </TooltipTrigger>
              <TooltipContent>
                Parsed out of a shell command, so the file and lines are
                inferred rather than read from a tool argument.
              </TooltipContent>
            </Tooltip>
          ) : null}
        </button>
      ) : (
        <span className="text-xs text-muted-foreground">
          No files the agent opened are still on disk.
        </span>
      )}

      <div className="ml-auto flex shrink-0 items-center gap-1">
        {skipped > 0 ? (
          <Tooltip>
            <TooltipTrigger
              render={<span className="text-xs text-muted-foreground" />}
            >
              {skipped} skipped
            </TooltipTrigger>
            <TooltipContent>
              The arrows skip {missing > 0 ? `${missing} no longer on disk` : ""}
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
            className="rounded border bg-transparent px-1 py-0.5 text-xs"
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
          className="rounded border px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
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
                className={cn(following && "bg-accent text-accent-foreground")}
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
