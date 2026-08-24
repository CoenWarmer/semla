import { useSessionMessages } from "./use-session-messages";
import { useWorkflowRuns } from "./use-workflow-runs";

export type SessionCost = {
  cost: number;
  tokens: number;
};

export function useSessionCost(sessionId: string): SessionCost {
  const runsQuery = useWorkflowRuns(sessionId);
  const messagesQuery = useSessionMessages(sessionId);

  const allRuns = runsQuery.data ?? [];
  const messages = messagesQuery.data ?? [];

  const runCost = allRuns.reduce(
    (sum, run) => sum + (run.snapshot?.tokenUsage?.cost ?? 0),
    0,
  );
  const runTokens = allRuns.reduce(
    (sum, run) => sum + (run.snapshot?.tokenUsage?.total ?? 0),
    0,
  );
  const msgCost = messages.reduce(
    (sum, m) => sum + (m.tokenUsage?.cost ?? 0),
    0,
  );
  const msgTokens = messages.reduce(
    (sum, m) => sum + (m.tokenUsage?.total ?? 0),
    0,
  );

  return {
    cost: runCost > 0 ? runCost : msgCost,
    tokens: runTokens > 0 ? runTokens : msgTokens,
  };
}
