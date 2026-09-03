/**
 * The span sink for a session, reachable from the extension that needs it.
 *
 * A sink belongs to a Semla session, but the workflow extension is constructed
 * per pi session and knows nothing about Semla's ids. This is the same problem
 * `wiki-session-repo.ts` solves the same way: the turn publishes under the *pi
 * runtime* session id — the value the extension can read from
 * `ctx.sessionManager` — and the extension looks it up on session_start.
 *
 * Process-local, like the session registries beside it. A sink cannot be
 * serialised, and a turn running in another process has its own.
 *
 * Keyed by pi runtime session id rather than by Semla session id on purpose:
 * `session-service.ts` learned the hard way that keying this kind of lookup on
 * the Supabase row id makes every read miss silently — see the comment above
 * `piRuntimeSessionId` there.
 */

import {
  NO_HOST_TELEMETRY,
  type HostTelemetry,
} from "@/lib/pi/telemetry/host-recorder";
import type { SpanSink } from "@/lib/pi/telemetry/span-sink";

type Retained = {
  /**
   * The turn's own recorder, so a workflow run can ask which tool call is in
   * flight and nest inside it. Read live rather than captured: the answer
   * changes with every tool call.
   */
  host: HostTelemetry;
  sink: SpanSink;
  /**
   * The turn's span, so a workflow run started by this turn nests under it
   * (plan §8.4). Null for a turn recorded before host spans existed, or one
   * whose turn span could not be opened.
   */
  turnSpanId: string | null;
};

const sinks = new Map<string, Retained>();

export const retainSpanSink = (
  piRuntimeSessionId: string,
  sink: SpanSink,
  host: HostTelemetry = NO_HOST_TELEMETRY,
): void => {
  sinks.set(piRuntimeSessionId, { host, sink, turnSpanId: host.turnSpanId });
};

/**
 * Undefined is normal, not an error: a session with telemetry not yet wired,
 * or an extension that outlived the turn that published one.
 */
export const getSpanSink = (
  piRuntimeSessionId: string,
): SpanSink | undefined => sinks.get(piRuntimeSessionId)?.sink;

/**
 * The turn span to parent this session's workflow runs to.
 *
 * Null rather than undefined when there is no turn span, because a run with
 * no parent is a legitimate root — a background run recovered after a restart
 * has no turn to nest under.
 */
export const getTurnSpanId = (
  piRuntimeSessionId: string,
): string | null => sinks.get(piRuntimeSessionId)?.turnSpanId ?? null;

/** The turn's recorder, for anything that needs to ask it a live question. */
export const getHostTelemetry = (
  piRuntimeSessionId: string,
): HostTelemetry | undefined => sinks.get(piRuntimeSessionId)?.host;

export const releaseSpanSink = (piRuntimeSessionId: string): void => {
  sinks.delete(piRuntimeSessionId);
};
