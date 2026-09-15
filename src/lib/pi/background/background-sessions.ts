// Pi session objects hold a live bash executor and cannot be serialised to an
// external store. This map is therefore process-local — it survives only as
// long as the Node.js process that created it. Horizontal scaling or a
// serverless redeploy will drop all retained sessions. The application must
// run as a single persistent instance (NODE_ENV=production, one replica) for
// background workflow continuations to complete reliably.
type RetainedSession = {
  dispose(): void;
};

const sessions = new Map<string, RetainedSession>();

export const retainBackgroundSession = (runId: string, session: RetainedSession) => {
  sessions.set(runId, session);
};

export const releaseBackgroundSession = (runId: string) => {
  const session = sessions.get(runId);
  sessions.delete(runId);
  session?.dispose();
};
