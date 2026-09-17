/**
 * Turning the live tool-call stream into `ToolCallStep`s, client-side.
 *
 * The history endpoint groups a session's tool calls server-side, where the
 * arguments and the result are both in scope. While a turn is still running,
 * the client only has two flat, separately-fetched streams: every tool call
 * (`useSessionLiveToolCalls`, already used for the active-tool indicator and
 * the waterfall) and the subset that touched a file
 * (`useSessionLiveAccesses`). No new SSE event is worth adding for this —
 * `session-event-router.ts` already emits both halves — so this just joins
 * them by `FileAccess.callId`.
 *
 * Pure and free of `node:` imports, like `access-sequence.ts`: the browser
 * runs this on every render of the scrubber while a turn streams.
 */

import type { SessionToolCall } from "@/hooks/use-session-messages";

import {
  LIVE_TURN_ID,
  MAIN_AGENT,
  type FileAccess,
  type ToolCallStep,
} from "./access-types";

/**
 * The running turn's tool calls, each carrying the files it touched.
 *
 * Every live tool call becomes a step, whether or not it produced a
 * `FileAccess` — matching what the history endpoint does once the turn ends
 * and these are replaced by the persisted equivalents.
 */
export function toolCallStepsFromLive(
  liveCalls: readonly SessionToolCall[],
  liveAccesses: readonly FileAccess[],
): ToolCallStep[] {
  const accessesByCallId = new Map<string, FileAccess[]>();
  for (const access of liveAccesses) {
    const group = accessesByCallId.get(access.callId);
    if (group) group.push(access);
    else accessesByCallId.set(access.callId, [access]);
  }

  return liveCalls.map((call) => ({
    accesses: accessesByCallId.get(call.id) ?? [],
    // Always the host agent's own: a subagent's calls surface only after the
    // fact, via its own transcript in `withSubagentAccesses`.
    agent: MAIN_AGENT,
    at: call.createdAt,
    id: call.id,
    isError: call.isError ?? false,
    name: call.name,
    ...(call.summary ? { summary: call.summary } : {}),
    turnId: LIVE_TURN_ID,
  }));
}
