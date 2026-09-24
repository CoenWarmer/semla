/**
 * Run every effect `applyStreamEvent` (turn-stream-reducer.ts) describes.
 *
 * The reducer stays pure by returning effects as data; this is the one place
 * that actually touches a `QueryClient` on the turn stream's behalf. It used
 * to be a 13-case switch (`runStreamEffects`) living inside
 * `usePromptMutation`, closing over the hook's own `queryClient`,
 * `sessionId`, and `messagesKey` — which meant no effect could be exercised
 * without mounting the whole hook. This module takes those three as
 * ordinary parameters instead, so a test can call it directly against a
 * real `QueryClient`.
 *
 * `pushConsoleEvent` and `setListRunning`'s cache writes — split-out helpers
 * in the old hook — are folded in here as private functions rather than
 * accepted as injected callbacks: both only ever need `queryClient` and
 * `sessionId`, which this module already has, so there is no second adapter
 * to justify a seam for them.
 */
import type { QueryClient } from "@tanstack/react-query";

import type {
  SessionMessagesResult,
  SessionToolCall,
} from "@/hooks/use-session-messages";
import type { RecordedSpan } from "@/lib/pi/telemetry/span-sink";
import type { FileAccess } from "@/lib/pi/file-access/access-types";
import type { ReviewComment } from "@/lib/review/review-comment-types";
import { allReviewCommentsQueryKey, reviewCommentsQueryKey } from "@/hooks/use-review";
import { mergeSpans, sessionSpansKey } from "@/lib/trace/session-spans";
import { applyLiveToolEvent } from "@/lib/session/live-tool-calls";
import {
  applyAgentConsoleEvent,
  type AgentConsoleEntry,
} from "@/lib/session/agent-console";
import {
  sessionAgentConsoleKey,
  sessionLiveAccessesKey,
  sessionLiveToolCallsKey,
} from "@/lib/session/session-live-state";
import {
  SESSION_STATUS_KEY,
  sessionStatusKey,
  withSessionRunning,
  type SessionStatus,
  type SingleSessionStatus,
} from "@/lib/session/session-status";
import type { TurnStreamEffect } from "@/lib/session/turn-stream-reducer";

/**
 * Fold a console event into the cache the console panel reads.
 *
 * Cache only, with no companion `useState`: the console panel lives outside
 * this stream's subtree, so the cache is the only way it can see the state
 * at all.
 */
function pushConsoleEvent(
  queryClient: QueryClient,
  sessionId: string,
  event: Parameters<typeof applyAgentConsoleEvent>[1],
): void {
  queryClient.setQueryData(sessionAgentConsoleKey(sessionId), (prev) =>
    applyAgentConsoleEvent(
      (prev as AgentConsoleEntry[] | undefined) ?? [],
      event,
    ),
  );
}

/**
 * Tell the sidebar's session list what this session is doing right now,
 * without waiting for its own poll to catch up.
 */
function setListRunning(
  queryClient: QueryClient,
  sessionId: string,
  isRunning: boolean,
): void {
  queryClient.setQueryData<SessionStatus[]>(SESSION_STATUS_KEY, (prev) =>
    withSessionRunning(prev, sessionId, isRunning),
  );
}

/**
 * Run every effect `applyStreamEvent` asked for, against a real
 * `QueryClient`.
 *
 * `messagesKey` is passed in rather than derived here: it depends on
 * `viewingLeafId`, which is the hook's own concern (see
 * `sessionMessagesQueryKey`'s doc), not this module's.
 *
 * `isReconnect` gates the one effect whose meaning differs by which stream
 * it arrived on: a `user-message` echo means "show it optimistically" only
 * when reconnecting to a turn already in progress — for a turn this tab
 * itself started, the mutation's `onMutate` already wrote that optimistic
 * message directly, and appending it again here would duplicate it.
 */
export function applyTurnEffects(
  queryClient: QueryClient,
  sessionId: string,
  messagesKey: readonly unknown[],
  effects: readonly TurnStreamEffect[],
  options?: { isReconnect?: boolean },
): void {
  for (const effect of effects) {
    switch (effect.type) {
      case "append-optimistic-user-message": {
        if (!options?.isReconnect) break;
        queryClient.setQueryData<SessionMessagesResult>(
          messagesKey,
          (prev) => ({
            contextWindow: prev?.contextWindow ?? null,
            systemPromptChars: prev?.systemPromptChars,
            toolCalls: prev?.toolCalls ?? [],
            messages: [
              ...(prev?.messages ?? []),
              {
                createdAt: new Date().toISOString(),
                id: `optimistic-reconnect-${crypto.randomUUID()}`,
                role: "user" as const,
                text: effect.text,
              },
            ],
          }),
        );
        break;
      }

      // Attaches to the last message in the cache rather than to the
      // optimistic bubble's own id: `onMutate`'s optimistic write already
      // landed by the time this event arrives (user-message precedes it on
      // the wire, and `onMutate` ran synchronously before the fetch that
      // opens the stream), but its id is not known here without threading
      // it through — the last message is that bubble by construction,
      // since nothing else appends to this list between `onMutate` and the
      // turn's own assistant reply.
      case "apply-wiki-recall":
        queryClient.setQueryData<SessionMessagesResult>(
          messagesKey,
          (prev) => {
            if (!prev || prev.messages.length === 0) return prev;
            const lastIndex = prev.messages.length - 1;
            const last = prev.messages[lastIndex];
            if (!last || last.role !== "user") return prev;
            const messages = [...prev.messages];
            messages[lastIndex] = { ...last, wikiRecall: effect.content };
            return {
              contextWindow: prev.contextWindow,
              messages,
              systemPromptChars: prev.systemPromptChars,
              toolCalls: prev.toolCalls,
            };
          },
        );
        break;

      case "cache-live-tool-call":
        queryClient.setQueryData(
          sessionLiveToolCallsKey(sessionId),
          (prev) =>
            applyLiveToolEvent(
              (prev as SessionToolCall[] | undefined) ?? [],
              effect.event,
            ),
        );
        break;

      // The command is on the start event's params and nowhere else, so
      // the console entry has to be opened here rather than on first
      // output.
      case "console-bash-start":
        pushConsoleEvent(queryClient, sessionId, {
          at: effect.at,
          command: effect.command,
          toolCallId: effect.toolCallId,
          type: "bash-start",
        });
        break;

      case "console-bash-end":
        pushConsoleEvent(queryClient, sessionId, {
          at: effect.at,
          isError: effect.isError,
          toolCallId: effect.toolCallId,
          type: "bash-end",
          ...(effect.output ? { output: effect.output } : {}),
        });
        break;

      case "console-bash-output":
        pushConsoleEvent(queryClient, sessionId, {
          output: effect.output,
          toolCallId: effect.toolCallId,
          type: "bash-output",
        });
        break;

      // Push live spans into the query cache so components that read
      // `sessionSpansKey` directly (session-agents-panel) see them too —
      // without this they only ever see the persisted-on-disk copy.
      case "cache-spans":
        queryClient.setQueryData(
          sessionSpansKey(sessionId),
          (prev: RecordedSpan[] | undefined) =>
            mergeSpans(
              prev ?? [],
              new Map(effect.spans.map((s) => [s.spanId, s])),
            ),
        );
        break;

      case "cache-file-access":
        queryClient.setQueryData(
          sessionLiveAccessesKey(sessionId),
          (previous: FileAccess[] | undefined) => [
            ...(previous ?? []),
            ...effect.accesses,
          ],
        );
        break;

      // Grouped by (project, path) before writing: a batch from
      // place_review_comments can span several files, and each file's own
      // query key holds only that file's list — the same list
      // useReviewComments reads and open-review's own single-comment write in
      // client-session-component.tsx appends to.
      case "cache-review-comments": {
        const byFile = new Map<string, ReviewComment[]>();
        for (const comment of effect.comments) {
          const key = `${comment.projectPath}\u0000${comment.filePath}`;
          const list = byFile.get(key);
          if (list) list.push(comment);
          else byFile.set(key, [comment]);
        }
        for (const [key, comments] of byFile) {
          const [projectPath, filePath] = key.split("\u0000");
          queryClient.setQueryData<ReviewComment[]>(
            reviewCommentsQueryKey(sessionId, projectPath ?? null, filePath ?? null),
            (previous) => [...(previous ?? []), ...comments],
          );
        }
        // The session-wide sequence the comment cards' arrows step through,
        // appended ungrouped and in arrival order: that order *is* the
        // navigation order (see allReviewCommentsQueryKey), so regrouping it
        // by file here would reorder the walkthrough.
        queryClient.setQueryData<ReviewComment[]>(
          allReviewCommentsQueryKey(sessionId),
          (previous) => [...(previous ?? []), ...effect.comments],
        );
        break;
      }

      // Keep the cache the header badges and the sidebar read in step with
      // the same push, so a component that only reads `sessionStatusKey`
      // (session-agents-panel.tsx, header-actions.tsx) does not need its
      // own poll to learn it.
      case "cache-session-status":
        queryClient.setQueryData<SingleSessionStatus>(
          sessionStatusKey(sessionId),
          (prev) => (prev ? { ...prev, isRunning: effect.isRunning } : prev),
        );
        setListRunning(queryClient, sessionId, effect.isRunning);
        break;

      // So the sidebar shows the new title now rather than on its next
      // poll.
      case "invalidate-title":
        void queryClient.invalidateQueries({ queryKey: SESSION_STATUS_KEY });
        break;
    }
  }
}
