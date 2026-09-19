"use client";

/**
 * What Jev let the agent see for a turn, as a badge beside the prompt.
 *
 * `docs/plans/jev-agent-gating.md` §8. The same traceability argument as
 * `WikiRecallBadge` in message-edit.tsx, applied to a different question: that
 * badge answers "what informed this answer", and this one answers "what could
 * the agent have done". Both facts previously existed only in a session's raw
 * `.jsonl`, unreadable to the person who sent the prompt.
 *
 * The dropped names matter as much as the kept ones, so both are shown with
 * their probabilities. "Why didn't it use the browser here" is answerable by a
 * number next to `mcp`, and a `fail-closed` badge says the gate broke rather
 * than that the agent chose not to — a distinction that is invisible if only
 * the survivors are listed.
 *
 * Kept out of message-edit.tsx, which is already long and whose subject is
 * editing. It supplies a slot and nothing else.
 */

import { FilterIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { JevGateRecord } from "@/lib/pi/extensions/jev-gate/gate-record";
import { cn } from "@/lib/utils";

function formatScore(score: number | undefined): string {
  return score === undefined ? "—" : score.toFixed(2);
}

/**
 * Names with their scores, kept ones first.
 *
 * Sorted by score rather than alphabetically: the question a reader has is
 * "what was closest to the line", and the threshold is the interesting place
 * in the list.
 */
function ScoreList({
  kept,
  dropped,
  scores,
  threshold,
}: {
  kept: string[];
  dropped: string[];
  scores: Record<string, number>;
  threshold: number;
}) {
  const rows = [...kept, ...dropped].sort(
    (a, b) => (scores[b] ?? 0) - (scores[a] ?? 0),
  );
  const keptSet = new Set(kept);

  if (rows.length === 0) {
    return <p className="text-muted-foreground text-xs">None offered.</p>;
  }

  return (
    <ul className="space-y-0.5">
      {rows.map((name) => (
        <li className="flex items-baseline justify-between gap-3 text-xs" key={name}>
          <span
            className={cn(
              "truncate font-mono",
              keptSet.has(name) ? "text-foreground" : "text-muted-foreground line-through",
            )}
          >
            {name}
          </span>
          <span
            className={cn(
              "shrink-0 tabular-nums",
              (scores[name] ?? 0) >= threshold
                ? "text-foreground"
                : "text-muted-foreground",
            )}
          >
            {formatScore(scores[name])}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Decision({ record }: { record: JevGateRecord }) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium text-xs">
          {record.outcome === "decided"
            ? `Decision ${record.evaluation}`
            : record.outcome === "fail-closed"
              ? `Decision ${record.evaluation} — failed closed`
              : `Decision ${record.evaluation} — gate not configured`}
        </span>
        <span className="text-muted-foreground text-[10px] tabular-nums">
          {record.elapsedMs === undefined ? "" : `${record.elapsedMs}ms`}
          {record.costUsd === undefined ? "" : ` · $${record.costUsd.toFixed(6)}`}
        </span>
      </div>

      {record.reason && (
        // The reason is the whole value of a non-"decided" badge: without it,
        // a narrowed turn is indistinguishable from a quiet one.
        <p className="text-muted-foreground text-xs">{record.reason}</p>
      )}

      <div>
        <p className="mb-1 font-medium text-[10px] text-muted-foreground uppercase tracking-wide">
          Tools
        </p>
        <ScoreList
          dropped={record.droppedTools}
          kept={record.tools}
          scores={record.toolScores}
          threshold={record.threshold}
        />
      </div>

      {(record.skills.length > 0 || record.droppedSkills.length > 0) && (
        <div>
          <p className="mb-1 font-medium text-[10px] text-muted-foreground uppercase tracking-wide">
            Skills
          </p>
          <ScoreList
            dropped={record.droppedSkills}
            kept={record.skills}
            scores={record.skillScores}
            threshold={record.threshold}
          />
        </div>
      )}

      <div>
        <p className="mb-1 font-medium text-[10px] text-muted-foreground uppercase tracking-wide">
          Sources
        </p>
        <p className="text-muted-foreground text-xs">
          {record.mcpAllowed
            ? "MCP gateway available."
            : "MCP gateway withheld."}
        </p>
      </div>
    </div>
  );
}

export function JevGateBadge({ records }: { records: JevGateRecord[] }) {
  if (records.length === 0) return null;

  // The last decision is the one in force when the turn ended, so it labels
  // the badge; the popover lists them all, because a mid-turn re-evaluation
  // means the agent had different tools at different moments.
  const last = records[records.length - 1];
  if (!last) return null;

  const label =
    last.outcome === "decided"
      ? `${last.tools.length} tool${last.tools.length === 1 ? "" : "s"}`
      : last.outcome === "fail-closed"
        ? "failed closed"
        : "not configured";

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            className="shrink-0"
            onClick={(event) => event.stopPropagation()}
            type="button"
          >
            <Badge
              className={cn(
                "gap-1",
                last.outcome === "fail-closed"
                  ? "text-amber-600 dark:text-amber-500"
                  : "text-muted-foreground",
              )}
              variant="outline"
            >
              <FilterIcon className="size-3" />
              Jev · {label}
            </Badge>
          </button>
        }
      />
      <PopoverContent
        align="end"
        className="max-h-96 w-80 space-y-3 overflow-y-auto text-left"
        onClick={(event) => event.stopPropagation()}
        side="top"
      >
        <div className="space-y-1">
          <p className="font-medium text-xs">Jev gating</p>
          <p className="text-muted-foreground text-[11px] leading-relaxed">
            Kept at or above {last.threshold.toFixed(2)}
            {last.model ? ` · ${last.model}` : ""}
          </p>
        </div>
        {records.map((record) => (
          <Decision key={record.evaluation} record={record} />
        ))}
      </PopoverContent>
    </Popover>
  );
}
