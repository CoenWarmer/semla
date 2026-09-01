/**
 * When to reattach to a turn's stream, and when to stop asking.
 *
 * A dropped stream and a finished turn are indistinguishable from the client —
 * both are an absence of events — so the page takes a second opinion from the
 * status poll and reattaches when the server says a session is running while
 * nothing is arriving here.
 *
 * The gap that made this a spin loop: the status poll is a *cache*, refreshed
 * every few seconds, so it goes on saying "running" for a moment after a turn
 * ends. Reattaching returns 404, the reconnect settles, and the effect's
 * conditions are true again — with nothing recording that the server has
 * already been asked and has already answered. In a capture of a two-prompt
 * session that was eight reattach attempts in 1.15 seconds, each dragging two
 * transcript refetches behind it, all of them after the conversation was over.
 *
 * `streamKnownDead` is that missing memory. It is set when a reattach is told
 * there is no stream, and cleared only when the server reports a *new* turn —
 * so a genuinely dropped stream still reattaches on the first attempt, which is
 * the case this mechanism exists for.
 */

export interface ReconnectConditions {
  /** The status poll says a turn is in flight for this session. */
  serverIsRunning: boolean;
  /** A submit from this page is in flight; its own stream is arriving. */
  isPending: boolean;
  /** A reattach is already under way. */
  isReconnecting: boolean;
  /** A reattach has been told this session has no stream, and nothing has changed since. */
  streamKnownDead: boolean;
}

/**
 * Whether to attempt a reattach right now.
 *
 * Reattaching over a live stream would tear down the one that is working, so a
 * submit in flight or a reattach already under way both mean "not now".
 */
export function shouldReconnect({
  serverIsRunning,
  isPending,
  isReconnecting,
  streamKnownDead,
}: ReconnectConditions): boolean {
  if (!serverIsRunning) return false;
  if (isPending || isReconnecting) return false;
  return !streamKnownDead;
}

/**
 * Whether the "no stream" memory should be discarded.
 *
 * Only a turn that was not running and now is counts as new. Holding the latch
 * on the *absence* of a running turn is what makes it safe: without the
 * transition test, one 404 would suppress reattachment for the rest of the page's
 * life, and a genuinely dropped stream would never recover.
 */
export function clearsDeadStreamLatch(
  previousServerIsRunning: boolean,
  nextServerIsRunning: boolean,
): boolean {
  return !previousServerIsRunning && nextServerIsRunning;
}
