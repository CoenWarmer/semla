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
}

const running = new Map<string, StoppableSession>();

export const retainLiveSession = (
  semlaSessionId: string,
  session: StoppableSession,
): void => {
  running.set(semlaSessionId, session);
};

export const releaseLiveSession = (semlaSessionId: string): void => {
  running.delete(semlaSessionId);
};

export const getLiveSession = (
  semlaSessionId: string,
): StoppableSession | undefined => running.get(semlaSessionId);

export const isSessionLive = (semlaSessionId: string): boolean =>
  running.has(semlaSessionId);
