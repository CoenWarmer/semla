/**
 * The diagnostic plumbing around one subagent turn: abort forwarding, throttled
 * history emission, and the context-pressure signal accumulator — plus the
 * teardown that must run whether the turn succeeded or threw.
 *
 * Split out of agent.ts because this is the auxiliary half of `run()`: three
 * listeners, three unsubscribes, and four separate best-effort try/catch
 * blocks, none of which can be allowed to change what `run()` returns or
 * throws. Keeping it here leaves `run()` reading as the turn it drives, and
 * makes the one invariant that matters testable in isolation: every callback
 * fires on BOTH the success and error paths, and a failure in any of them is
 * swallowed rather than masking the real result.
 *
 * `settle()` is idempotent-by-construction in the sense `run()` needs: it is
 * called exactly once, from a `finally`, and disposes the session last.
 */

import {
  type AgentContextSignals,
  createEmptyAgentContextSignals,
  recordCompactionSignal,
  recordStopReason,
} from "./agent-context-signals.ts";
import { compactAgentHistory } from "./agent-history.ts";
import { lastAssistantError, usageFromStats } from "./agent-output.ts";
import type { AgentUsage } from "./agent-types.ts";

/** Minimum gap between history emissions, so a chatty turn can't flood the UI. */
const HISTORY_THROTTLE_MS = 250;

/** The session surface these observers need (the real AgentSession, or a test double). */
export interface ObservableSession {
  messages: unknown[];
  subscribe(listener: (event: unknown) => void): () => void;
  abort(): unknown;
  getSessionStats(): {
    tokens: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      total: number;
    };
    cost: number;
  };
  dispose(): void;
}

/** The subset of AgentRunOptions this plumbing reads. */
export interface RunObserverOptions {
  signal?: AbortSignal;
  onHistory?: (history: ReturnType<typeof compactAgentHistory>) => void;
  onUsage?: (usage: AgentUsage) => void;
  onContextSignals?: (signals: AgentContextSignals) => void;
}

export interface RunObservers {
  /**
   * This turn's context-pressure accumulator. `run()` reads it directly to
   * decide between AGENT_CONTEXT_EXHAUSTED and a partial result, so it must be
   * the same object `settle()` later reports through onContextSignals.
   */
  readonly contextSignals: AgentContextSignals;
  /**
   * Detach every listener, emit the final diagnostics, and dispose the session.
   * Call once, from `run()`'s `finally`. Never throws.
   */
  settle(): void;
}

/**
 * Attach this turn's observers to a session and hand back its teardown.
 *
 * The three subscriptions are deliberately separate. History is throttled and
 * only wired when a consumer asked for it; the context-signal subscription is
 * unconditional and unthrottled, because dropping a compaction event would
 * corrupt the exhaustion decision `run()` makes from it.
 */
export function attachRunObservers(
  session: ObservableSession,
  options: RunObserverOptions,
): RunObservers {
  const contextSignals = createEmptyAgentContextSignals();
  const detach: Array<() => void> = [];

  if (options.signal) {
    const signal = options.signal;
    const onAbort = () => void session.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    detach.push(() => signal.removeEventListener("abort", onAbort));
  }

  let lastHistoryEmit = 0;
  const emitHistory = () =>
    options.onHistory?.(compactAgentHistory(session.messages));
  if (options.onHistory) {
    detach.push(
      session.subscribe(() => {
        const now = Date.now();
        if (now - lastHistoryEmit < HISTORY_THROTTLE_MS) return;
        lastHistoryEmit = now;
        emitHistory();
      }),
    );
  }

  // Diagnostic-only accumulator for §4.1's capture (context-pressure signals).
  // Fed by the same session event stream as history, but via its own
  // subscription rather than folding into the history throttle — recording a
  // compaction event must never be dropped by that 250ms gate, and this
  // subscribe() is independent of whether options.onHistory is even set.
  detach.push(
    session.subscribe((event) => {
      try {
        recordCompactionSignal(contextSignals, event as { type: string });
      } catch {
        // Diagnostic only — never let a malformed event break the run.
      }
    }),
  );

  return {
    contextSignals,
    settle() {
      for (const off of detach) {
        try {
          off();
        } catch {
          // A listener that won't detach must not mask the real result/error.
        }
      }
      try {
        emitHistory();
      } catch {
        // History is diagnostic only; never let it mask the real result/error.
      }
      // Read real usage before disposing — dispose tears down the session state.
      if (options.onUsage) {
        try {
          const usage = usageFromStats(session.getSessionStats());
          if (usage) options.onUsage(usage);
        } catch {
          // Usage is best-effort; never let stats failure mask the real result/error.
        }
      }
      // Same contract as onUsage/history: diagnostic only, read before disposal,
      // failure caught and ignored so it can never mask the real result/error.
      if (options.onContextSignals) {
        try {
          recordStopReason(
            contextSignals,
            lastAssistantError(session.messages)?.stopReason,
          );
          options.onContextSignals(contextSignals);
        } catch {
          // Context signals are diagnostic only.
        }
      }
      session.dispose();
    },
  };
}
