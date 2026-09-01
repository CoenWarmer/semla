"use client";

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
  elapsedLabel,
  estimatedTokens,
  streaming,
}: {
  /** A turn is in flight. The same value the prompt bar gets as `isRunning`. */
  active: boolean;
  /** The tool being run, when the turn is in a tool call. */
  activeTool?: string;
  /** Time since the turn started, once it is worth showing. */
  elapsedLabel: string | null;
  /** Rough output tokens so far, or null before anything has streamed. */
  estimatedTokens: number | null;
  /** Text is arriving from the model right now. */
  streaming: boolean;
}) {
  if (!active) return null;

  return (
    <div className="flex items-center gap-2 text-muted-foreground text-sm">
      <Spinner />
      <span>{activityLabel(activeTool, streaming)}</span>
      {elapsedLabel && <span className="tabular-nums">{elapsedLabel}</span>}
      <TokenUsage approximate tokens={estimatedTokens} />
    </div>
  );
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
