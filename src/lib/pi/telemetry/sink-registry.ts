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

import type { SpanSink } from "@/lib/pi/telemetry/span-sink";

const sinks = new Map<string, SpanSink>();

export const retainSpanSink = (
  piRuntimeSessionId: string,
  sink: SpanSink,
): void => {
  sinks.set(piRuntimeSessionId, sink);
};

/**
 * Undefined is normal, not an error: a session with telemetry not yet wired,
 * or an extension that outlived the turn that published one.
 */
export const getSpanSink = (
  piRuntimeSessionId: string,
): SpanSink | undefined => sinks.get(piRuntimeSessionId);

export const releaseSpanSink = (piRuntimeSessionId: string): void => {
  sinks.delete(piRuntimeSessionId);
};
