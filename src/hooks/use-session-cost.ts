import { addUsage, type SessionUsage } from "@/lib/session-usage";

import { useSessionMessages } from "./use-session-messages";
import { useWorkflowRuns } from "./use-workflow-runs";

export type SessionCost = SessionUsage;

export function useSessionCost(sessionId: string): SessionCost {
  const runsQuery = useWorkflowRuns(sessionId);
  const messagesQuery = useSessionMessages(sessionId);

  const allRuns = runsQuery.data ?? [];
  const messages = messagesQuery.data?.messages ?? [];

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

  // Summed, not chosen. The either/or this replaces reported the workflows
  // and discarded the conversation for any session that had run one — which
  // is why this disagreed with the sidebar by an order of magnitude. See
  // session-usage.ts for why the two sets cannot double count.
  return addUsage(
    { cost: runCost, tokens: runTokens },
    { cost: msgCost, tokens: msgTokens },
  );
}
