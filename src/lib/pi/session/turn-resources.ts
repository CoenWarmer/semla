/**
 * The turn's per-resource retention, accumulated in acquisition order and
 * released in the exact reverse.
 *
 * `runPiPrompt` opens six session-scoped registrations — the event
 * subscription, the ask-user and feature-spec rendezvous notifiers, the
 * live-session handle, the wiki repo attribution, and the span sink — and used
 * to release all six by hand in its own `finally`, in an order that had to be
 * kept in sync with acquisition by eye. Nothing could exercise that release
 * sequence without a live provider and Supabase, because it lived nowhere but
 * that `finally`.
 *
 * This module gives the sequence one place to live: call `push` once per
 * resource, right where `runPiPrompt` already acquires it, and call `release`
 * once at the end. `release` pops what was actually pushed, so a turn that
 * throws before acquiring all six still releases exactly the ones it holds —
 * that is the point of making this a stack rather than a fixed list.
 *
 * Deliberately narrow: this is `runPiPrompt`'s own accumulator, not a general
 * "acquire N, release N" utility. A second caller would be the moment to
 * generalise; there isn't one yet. It also does not own `BRIDGE_RUN_STARTED`,
 * `CURRENT_TURN`, the turn slot, or the session stream/running-flag pair — all
 * four release later in `finally`, gated by the awaited span flush and the
 * `decision` branch, including the case where ownership transfers to a
 * background continuation. Folding that conditionality in here would move
 * their release earlier than today and blur the one thing this module is for.
 */

/** Releases one resource this turn acquired. Must not throw: every current
 * release call (`unsubscribe`, the rendezvous unregisters, `releaseLiveSession`,
 * `clearSessionRepo`, `releaseSpanSink`, `clearSessionSlot`) is declared to
 * return `void` and none of them can fail — see turn-resources.test.ts for the
 * partial-failure case this exists to make testable, not the case where a
 * disposer itself misbehaves. */
export type TurnResourceDisposer = () => void;

export class TurnResources {
  private readonly disposers: TurnResourceDisposer[] = [];

  /**
   * Record that a resource was just acquired. `dispose` is the exact release
   * call for that one resource — a synchronous no-throw closure that already
   * carries whatever identity guard the underlying registry needs (an object
   * reference for `releaseLiveSession`, the published value for
   * `clearSessionSlot`, nothing at all for the unguarded registries).
   */
  push(dispose: TurnResourceDisposer): void {
    this.disposers.push(dispose);
  }

  /**
   * Release every resource pushed so far, most recently acquired first.
   *
   * Idempotent: a second call releases nothing, because the first already
   * drained the stack. That matters less for correctness than for letting a
   * caller call this from one `finally` without worrying whether some other
   * path already ran it.
   */
  release(): void {
    while (this.disposers.length > 0) {
      const dispose = this.disposers.pop();
      dispose?.();
    }
  }
}
