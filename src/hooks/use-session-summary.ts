"use client";

/**
 * The session summary card's input, assembled from queries the session page
 * already runs.
 *
 * No route of its own, deliberately. Every field is either already on the
 * client (the transcript, the workflow runs) or already polled for something
 * else (the status route, for projects and artifacts), and the status query
 * is keyed with `sessionStatusKey` so this shares the cache entry
 * `HeaderActions` and the agents panel already populate rather than adding a
 * fourth poll of the same file.
 *
 * `useReview` is the same story: the session page already holds the review
 * payload under `["review", sessionId]`, and the card's "uncommitted diff"
 * row needs git to know a file has since been committed — so this reads that
 * cache entry rather than adding a poll of its own.
 *
 * `useSessionCost` supplies the total rather than this hook summing it again:
 * a session's cost is the one number three places got independently wrong
 * once (see session-usage.ts), and there should not be a fourth opinion.
 */

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { useReview } from "@/hooks/use-review";
import { useSessionCost } from "@/hooks/use-session-cost";
import { useSessionMessages } from "@/hooks/use-session-messages";
import { useWorkflowRuns } from "@/hooks/use-workflow-runs";
import { dirtyFilesFromReview } from "@/lib/artifacts/artifact-dirty";
import {
  buildSessionSummary,
  computeSessionStats,
  type SessionSummary,
} from "@/lib/session/session-summary";
import {
  fetchSingleSessionStatus,
  sessionStatusKey,
} from "@/lib/session/session-status";
import { deriveWikiActivity } from "@/lib/session/wiki-activity";
import type { WorkflowSnapshot } from "@/types/workflow";

export function useSessionSummary({
  goal,
  model,
  sessionId,
  snapshot,
  title,
}: {
  goal: string | null;
  /** The session's model, from the transcript payload the page already has. */
  model: string | null;
  sessionId: string;
  /** The live run, which can be ahead of the polled list. */
  snapshot?: WorkflowSnapshot;
  title: string | null;
}): SessionSummary {
  const usage = useSessionCost(sessionId);
  const messagesQuery = useSessionMessages(sessionId);
  const runsQuery = useWorkflowRuns(sessionId, snapshot?.runId);
  const reviewQuery = useReview(sessionId);
  const statusQuery = useQuery({
    queryFn: () => fetchSingleSessionStatus(sessionId),
    queryKey: sessionStatusKey(sessionId),
  });

  const messages = messagesQuery.data?.messages;
  const toolCalls = messagesQuery.data?.toolCalls;

  // Memoized on the two arrays it scans: a long session has thousands of
  // tool calls, and this runs on every render of a panel that sits beside a
  // streaming conversation.
  const wiki = useMemo(
    () => deriveWikiActivity({ messages: messages ?? [], toolCalls: toolCalls ?? [] }),
    [messages, toolCalls],
  );

  const workflowRuns = runsQuery.data;
  const status = statusQuery.data;

  // Memoized for the same reason `wiki` is: derived from the same two
  // transcript arrays, which can hold thousands of entries in a long session.
  const stats = useMemo(
    () => computeSessionStats({ messages: messages ?? [], toolCalls: toolCalls ?? [] }),
    [messages, toolCalls],
  );

  // Memoized for the same reason `wiki` is: this rebuilds a set per project
  // and the card renders beside a streaming conversation.
  const dirty = useMemo(
    () => dirtyFilesFromReview(reviewQuery.data),
    [reviewQuery.data],
  );

  return useMemo(
    () =>
      buildSessionSummary({
        artifacts: status?.artifacts ?? null,
        dirty,
        goal,
        model,
        projects: (status?.projects ?? []).map((project) => project.path),
        snapshot,
        stats,
        title,
        usage,
        wiki,
        workflowRuns,
      }),
    [dirty, goal, model, snapshot, stats, status, title, usage, wiki, workflowRuns],
  );
}
