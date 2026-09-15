type StreamEvent = unknown;

type Subscriber = {
  onEvent: (event: StreamEvent) => void;
  /**
   * Told when the stream itself is torn down (closeSessionStream), as
   * distinct from a "complete"/"error" event arriving on it.
   *
   * Those two used to be the same signal: the route that turns this into SSE
   * treated a "complete"/"error" *event* as the cue to end the HTTP
   * response. That was fine as long as the store's lifetime was exactly one
   * prompt turn, but a background workflow's continuation now keeps the
   * store open past its originating turn's own "complete" — there is more
   * than one turn's worth of "complete" on a session that keeps chatting
   * while a workflow runs, and the *last* one is the only one that should
   * end anybody's connection. So closing is now driven by the resource
   * actually closing, not by interpreting the event stream's contents.
   */
  onClose?: () => void;
};

interface SessionStream {
  buffer: StreamEvent[];
  subscribers: Set<Subscriber>;
}

const streams = new Map<string, SessionStream>();

/**
 * Event types that describe a *current state* rather than a moment in time.
 *
 * A stream now stays open for the lifetime of a background workflow, not just
 * one prompt turn, so the buffer that lets a late subscriber replay history
 * would otherwise grow for as long as the workflow runs. These two types are
 * kept compacted to their latest value instead of accumulating: a subscriber
 * that attaches an hour into a run needs to know what is true *now*
 * (isRunning, the current snapshot), not to replay every intermediate one.
 * Every other event type (deltas, tool markers, spans, ...) is still buffered
 * in full, which is correct for the one prompt turn's worth of them a stream
 * normally carries.
 */
const REPLACEABLE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "session-status",
  "workflow-snapshot",
]);

const eventType = (event: StreamEvent): string | undefined => {
  const type = (event as { type?: unknown } | null)?.type;
  return typeof type === "string" ? type : undefined;
};

/**
 * Idempotent on purpose. A stream can now already be open when this is
 * called — a background continuation keeps one open across the handoff from
 * its originating prompt turn, and a new prompt for that same session (the
 * user keeps chatting while a workflow runs) calls this again at its own
 * start, before the old continuation's `finally` has stood down.
 *
 * Replacing the map entry unconditionally used to be harmless because a
 * stream's lifetime was exactly one prompt turn — nothing could still be
 * subscribed to the old one. That stopped being true the moment a
 * continuation started keeping the stream open: a client's `subscribeToSessionStream`
 * call closed over the specific `SessionStream` object it got back, so
 * overwriting the map entry here would silently orphan it — new events
 * publish into the new object, and the old one is never told to close,
 * so the client's connection just goes quiet with no `complete`/`error` and
 * no `onClose`. Reusing the existing stream instead means the subscriber
 * that has been watching this session across the handoff keeps watching it
 * across the next turn too.
 */
export const openSessionStream = (sessionId: string): void => {
  if (streams.has(sessionId)) return;
  streams.set(sessionId, { buffer: [], subscribers: new Set() });
};

export const publishToSessionStream = (sessionId: string, event: StreamEvent): void => {
  const stream = streams.get(sessionId);
  if (!stream) return;
  const type = eventType(event);
  if (type && REPLACEABLE_EVENT_TYPES.has(type)) {
    stream.buffer = stream.buffer.filter((e) => eventType(e) !== type);
  }
  stream.buffer.push(event);
  for (const sub of stream.subscribers) sub.onEvent(event);
};

export const subscribeToSessionStream = (
  sessionId: string,
  onEvent: (event: StreamEvent) => void,
  onClose?: () => void,
): { unsubscribe: () => void; isActive: boolean } => {
  const stream = streams.get(sessionId);
  if (!stream) return { unsubscribe: () => {}, isActive: false };
  for (const event of stream.buffer) onEvent(event);
  const subscriber: Subscriber = { onClose, onEvent };
  stream.subscribers.add(subscriber);
  return {
    unsubscribe: () => {
      stream.subscribers.delete(subscriber);
    },
    isActive: true,
  };
};

export const isSessionStreamActive = (sessionId: string): boolean =>
  streams.has(sessionId);

/**
 * Publish this session's running flag to its stream, if one is open.
 *
 * A no-op when the stream is already closed — the client learns the same fact
 * from the next `/status` fetch or the 404 on reconnect, both of which remain
 * as the fallback for exactly that gap.
 */
export const publishSessionRunning = (
  sessionId: string,
  isRunning: boolean,
): void => {
  publishToSessionStream(sessionId, { isRunning, type: "session-status" });
};

export const closeSessionStream = (sessionId: string): void => {
  const stream = streams.get(sessionId);
  streams.delete(sessionId);
  if (!stream) return;
  for (const sub of stream.subscribers) sub.onClose?.();
};
