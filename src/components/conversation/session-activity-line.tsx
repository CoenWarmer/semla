"use client";

import { useEffect, useState } from "react";

import { TokenUsage } from "@/components/token-usage";
import { Spinner } from "@/components/ui/spinner";

/**
 * What the session is doing right now, shown under the conversation.
 *
 * Driven by the *same* signal as the prompt bar's submit button, which turns
 * into a stop button while a turn is in flight. They are two views of one fact,
 * and the failure mode of letting them diverge is a stop button above a
 * conversation showing no sign that anything is happening.
 *
 * Previously this line was hidden whenever any text had streamed in, which made
 * it disappear for the rest of the turn the moment the assistant said anything —
 * including while a tool ran afterwards, the case its own label was written for.
 * `streamingText` is only cleared when a turn starts or ends, never when a tool
 * begins, so "Running x…" could not appear after the first token of prose.
 */
export function SessionActivityLine({
  active,
  activeTool,
  liveTextLength,
  turnStartedAt,
}: {
  /** A turn is in flight. The same value the prompt bar gets as `isRunning`. */
  active: boolean;
  /** The tool being run, when the turn is in a tool call. */
  activeTool?: string;
  /** Characters of prose streamed so far this turn, across every round trip. */
  liveTextLength: number;
  /**
   * When the current turn actually started, from the server's own record.
   * `null` when the server has not said (an old record, or a race with the
   * first `session-status` push) — `ElapsedTime` falls back to its own mount
   * time only in that case.
   */
  turnStartedAt: string | null;
}) {
  if (!active) return null;

  return (
    <div className="flex items-center gap-2 text-muted-foreground text-sm">
      <Spinner />
      <span>{activityLabel(activeTool, liveTextLength > 0)}</span>
      <ElapsedTime turnStartedAt={turnStartedAt} />
      <TokenUsage approximate tokens={estimateOutputTokens(liveTextLength)} />
    </div>
  );
}

/**
 * Time since the turn actually started — not since this line happened to
 * mount.
 *
 * `turnStartedAt` comes from the server's own record (see SessionMeta's
 * `turnStartedAt`), so a page refresh mid-turn re-mounts this component but
 * keeps counting from the same start: the effect re-derives elapsed time from
 * that fixed instant on every tick rather than measuring from its own mount.
 * Only a turn whose start the server has not reported — an old record
 * written before this field existed, or a brief race before the first
 * `session-status` push — falls back to counting from mount, and only for
 * that one turn.
 *
 * A leaf of its own because it ticks twice a second: held any higher, every
 * tick re-rendered the whole session page — transcript, prompt bar, review
 * panel — to change one number.
 */
function ElapsedTime({ turnStartedAt }: { turnStartedAt: string | null }) {
  const [mountedAt] = useState(() => Date.now());
  const start = turnStartedAt ? new Date(turnStartedAt).getTime() : mountedAt;

  const [elapsedMs, setElapsedMs] = useState(() => Date.now() - start);

  useEffect(() => {
    const id = setInterval(() => setElapsedMs(Date.now() - start), 500);
    return () => clearInterval(id);
  }, [start]);

  if (elapsedMs < 1000) return null;
  return <span className="tabular-nums">{(elapsedMs / 1000).toFixed(1)}s</span>;
}

/**
 * Rough output tokens: ~4 characters each. No cost — the real usage, and its
 * price, only arrive with the finished message.
 */
function estimateOutputTokens(liveTextLength: number): number | null {
  return liveTextLength > 0 ? Math.round(liveTextLength / 4) : null;
}

/**
 * What to call the current activity.
 *
 * A tool call is the most specific thing to say and wins. Otherwise the
 * distinction is whether anything is coming back yet: prose already arriving is
 * not "thinking", and saying so under a visibly growing message reads as though
 * the session were stuck.
 */
export function activityLabel(
  activeTool: string | undefined,
  streaming: boolean,
): string {
  if (activeTool) return `Running ${activeTool}…`;
  return streaming ? "Responding…" : "Thinking…";
}
