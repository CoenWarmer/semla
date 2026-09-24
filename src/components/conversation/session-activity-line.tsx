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
}: {
  /** A turn is in flight. The same value the prompt bar gets as `isRunning`. */
  active: boolean;
  /** The tool being run, when the turn is in a tool call. */
  activeTool?: string;
  /** Characters of prose streamed so far this turn, across every round trip. */
  liveTextLength: number;
}) {
  if (!active) return null;

  return (
    <div className="flex items-center gap-2 text-muted-foreground text-sm">
      <Spinner />
      <span>{activityLabel(activeTool, liveTextLength > 0)}</span>
      <ElapsedTime />
      <TokenUsage approximate tokens={estimateOutputTokens(liveTextLength)} />
    </div>
  );
}

/**
 * Time since this line appeared, i.e. since the turn started.
 *
 * A leaf of its own because it ticks twice a second: held any higher, every
 * tick re-rendered the whole session page — transcript, prompt bar, review
 * panel — to change one number. Mounting is the start signal, so there is no
 * reset to perform when the turn ends; the line unmounts instead.
 */
function ElapsedTime() {
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    const start = Date.now();
    const id = setInterval(() => setElapsedMs(Date.now() - start), 500);
    return () => clearInterval(id);
  }, []);

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
