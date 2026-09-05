/**
 * Pi sessions currently running a turn, so one can be stopped.
 *
 * A turn is an agent loop inside this process; nothing outside it can reach the
 * loop to interrupt it. Without a handle, the only way to stop a run that had
 * gone wrong was to wait it out or restart the server — and orient turns run
 * for tens of minutes.
 *
 * Process-local for the same reason background sessions are: a pi session holds
 * a live bash executor and cannot be serialised anywhere. A stop request that
 * arrives at a process which is not running the turn simply finds nothing,
 * which is the honest answer.
 */

export interface StoppableSession {
  abort(): Promise<void>;
  compact(customInstructions?: string): Promise<unknown>;
}

const running = new Map<string, StoppableSession>();

export const retainLiveSession = (
  semlaSessionId: string,
  session: StoppableSession,
): void => {
  running.set(semlaSessionId, session);
};

/**
 * Let go of a session's live handle, identified by the handle itself.
 *
 * Guarded by reference equality, mirroring `releaseBackgroundContinuation`'s
 * pattern for the same reason: a turn that has been superseded is aborted and
 * unwinds through this same call in its own `finally`, but by then a new turn
 * may already have registered its own handle for the same session id. An
 * unconditional delete would race the two — whichever `finally` runs last
 * would decide whether the session looks live, regardless of which turn is
 * actually running. Passing the handle makes the release a no-op once it is
 * no longer the current one, so a superseded turn can never clear a newer
 * turn's registration out from under it. See docs/plans/superseded-turns.md
 * §4 (Phase 1).
 */
export const releaseLiveSession = (
  semlaSessionId: string,
  session: StoppableSession,
): void => {
  if (running.get(semlaSessionId) === session) {
    running.delete(semlaSessionId);
  }
};

export const getLiveSession = (
  semlaSessionId: string,
): StoppableSession | undefined => running.get(semlaSessionId);

export const isSessionLive = (semlaSessionId: string): boolean =>
  running.has(semlaSessionId);
