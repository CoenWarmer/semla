/**
 * Diagnostic-only signals about a subagent's own context pressure.
 *
 * See docs/plans/subagent-context-pressure.md §4.1 — Phase 1 is measurement
 * only. A subagent is a full pi AgentSession, and pi already emits
 * compaction_start/compaction_end on the same session.subscribe(...) stream
 * agent.ts reads for history; it also already reads the last assistant
 * message's stopReason (lastAssistantError, in agent.ts) but only to match
 * provider-limit text. Nothing currently counts either. This module is the
 * accumulator agent.ts's existing subscription feeds — extracted to its own
 * file rather than growing agent.ts further (which is already large).
 *
 * Strictly diagnostic: nothing here changes what agent() returns or throws.
 * A caller reads `signals` whenever it likes; recording an event never
 * throws, so a malformed event can't mask the real result/error the same way
 * the existing history capture can't (agent.ts's finally block).
 */

/** pi's own reason vocabulary for a compaction (compaction_start/compaction_end). */
export type CompactionReason = "manual" | "threshold" | "overflow";

/** One compaction cycle this subagent's session ran, in full. */
export interface CompactionEvent {
  /** Undefined when pi reported a reason outside its documented vocabulary. */
  reason?: CompactionReason;
  /**
   * Only known once compaction_end fires. willRetry / tokensBefore /
   * estimatedTokensAfter come from that event (compaction_end's own
   * CompactionResult), not compaction_start — see pi's
   * core/agent-session.d.ts. Undefined when compaction_end never arrived
   * (the session was disposed mid-compaction).
   */
  willRetry?: boolean;
  tokensBefore?: number;
  estimatedTokensAfter?: number;
}

/**
 * Per-agent-call context-pressure totals. `compactions` and
 * `compactionReasons` are what's threaded through
 * onAgentEnd -> WorkflowManager -> WorkflowAgentSnapshot -> PersistedAgentState
 * -> telemetry, per the plan's §4.2 seam table; `events` keeps the fuller
 * per-cycle detail (willRetry, tokensBefore/estimatedTokensAfter) that the
 * plan's §4.1 capture asks for but whose seams are deliberately narrower —
 * available to a caller that wants more than the seam table carries, without
 * widening every downstream type for it.
 */
export interface AgentContextSignals {
  /** How many compaction cycles this subagent's session ran (manual + auto). */
  compactions: number;
  /** The `reason` of each compaction_start seen, in call order. */
  compactionReasons: CompactionReason[];
  /** Full per-cycle detail, in call order. */
  events: CompactionEvent[];
  /** The last assistant message's stopReason, when any turn produced one. */
  stopReason?: string;
}

export function createEmptyAgentContextSignals(): AgentContextSignals {
  return { compactions: 0, compactionReasons: [], events: [] };
}

/**
 * Narrow shape this module reads off pi's AgentSessionEvent union — just the
 * `compaction_start` / `compaction_end` members' fields (see
 * node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts).
 * Declared locally, rather than importing the full AgentSessionEvent union,
 * so a session double in a test can satisfy it without constructing every
 * other event variant.
 */
export interface CompactionEventLike {
  type: string;
  reason?: string;
  willRetry?: boolean;
  result?: { tokensBefore?: number; estimatedTokensAfter?: number };
}

const KNOWN_REASONS: ReadonlySet<CompactionReason> = new Set([
  "manual",
  "threshold",
  "overflow",
]);

/**
 * Fold one session event into `signals`, in place. A no-op for any event
 * that isn't `compaction_start`/`compaction_end` — including a
 * `compaction_start` whose `reason` isn't in pi's documented vocabulary, so a
 * future pi release adding a reason can't corrupt the count (the compaction
 * is still counted; the reason is just dropped from `compactionReasons`/
 * `events`).
 */
export function recordCompactionSignal(
  signals: AgentContextSignals,
  event: CompactionEventLike,
): void {
  if (event.type === "compaction_start") {
    signals.compactions += 1;
    const reason = KNOWN_REASONS.has(event.reason as CompactionReason)
      ? (event.reason as CompactionReason)
      : undefined;
    if (reason) signals.compactionReasons.push(reason);
    signals.events.push({ reason });
    return;
  }
  if (event.type === "compaction_end") {
    // Pairs with the compaction_start pushed above (session events are
    // ordered) — but if a start was somehow missed, append a fresh entry
    // rather than silently dropping the detail.
    const entry = signals.events.at(-1) ?? { reason: undefined };
    entry.willRetry = event.willRetry;
    entry.tokensBefore = event.result?.tokensBefore;
    entry.estimatedTokensAfter = event.result?.estimatedTokensAfter;
    if (signals.events.length === 0) signals.events.push(entry);
  }
}

/** Record the last assistant message's stopReason, when known. */
export function recordStopReason(
  signals: AgentContextSignals,
  stopReason: string | undefined,
): void {
  if (stopReason !== undefined) signals.stopReason = stopReason;
}
