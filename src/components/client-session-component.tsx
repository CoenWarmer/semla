"use client";

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input";
import { usePromptMutation } from "@/hooks/use-prompt-mutation";
import { useSessionMessages } from "@/hooks/use-session-messages";
import { mergeToolCalls } from "@/lib/live-tool-calls";
import { useTriggerContextCheck } from "@/hooks/use-context-check";
import {
  useWorkflowRuns,
  workflowRunsQueryKey,
} from "@/hooks/use-workflow-runs";
import type { WorkflowSnapshot } from "@/types/workflow";
import { Spinner } from "@/components/ui/spinner";
import { AgentTranscriptDrawer } from "./agent-transcript-drawer";
import { AskUserDialog } from "./ask-user-dialog";
import { GoalEditor } from "./goal-editor";
import dynamic from "next/dynamic";

const WikiMiniGraph = dynamic(
  () => import("./wiki/wiki-mini-graph").then((m) => m.WikiMiniGraph),
  { ssr: false },
);
import { PromptEditor, type PromptEditorModel } from "./prompt-editor";
import { SessionTopbar } from "./session-topbar";
import { TokenUsage } from "./token-usage";
import { MessageSquareIcon } from "lucide-react";
import {
  usePendingPrompt,
  type PendingPrompt,
} from "@/components/pending-prompt-provider";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export function ClientSessionComponent({
  defaultTools,
  goal: initialGoal,
  initialMessagesData,
  isRunning,
  sessionId,
  title,
}: {
  defaultTools: string[];
  goal?: string | null;
  initialMessagesData?: import("@/hooks/use-session-messages").SessionMessagesResult;
  isRunning?: boolean;
  sessionId: string;
  title: string | null;
}) {
  const {
    activeTool,
    isReconnecting,
    liveToolCalls,
    mutation: promptMutation,
    pendingQuestion,
    streamError,
    streamingText,
    wikiActive,
    workflowSnapshot,
  } = usePromptMutation(sessionId, isRunning);

  const { consume: consumePendingPrompt } = usePendingPrompt();
  const [goal, setGoal] = useState<string | null>(initialGoal ?? null);

  const handleStop = useCallback(() => {
    // Fire and forget: the turn ends through the stream closing, and a failed
    // stop should not leave the button wedged. Errors surface in the log.
    void fetch(`/api/sessions/${sessionId}/stop`, { method: "POST" }).catch(
      (error: unknown) => {
        console.warn("[session] stop failed:", error);
      },
    );
  }, [sessionId]);

  const handleGoalSave = useCallback(async (next: string | null) => {
    setGoal(next);
    await fetch(`/api/sessions/${sessionId}`, {
      body: JSON.stringify({ goal: next ?? "" }),
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    });
  }, [sessionId]);

  const queryClient = useQueryClient();
  const isActive = promptMutation.isPending || isReconnecting;
  // Paused mid-turn: the server has no rows for a turn until it ends, so an
  // unbidden refetch would replace the optimistic prompt with a list without it.
  const messagesQuery = useSessionMessages(
    sessionId,
    initialMessagesData,
    isActive,
  );
  const workflowRunsQuery = useWorkflowRuns(sessionId, workflowSnapshot?.runId);
  const messages = messagesQuery.data?.messages ?? [];
  // Persisted rows arrive only when the turn's entries are written, so fold in
  // the ones seen on the stream. Both are keyed by pi's tool call id, so a live
  // row becomes the persisted row rather than a second marker.
  const persistedToolCalls = messagesQuery.data?.toolCalls;
  const toolCalls = useMemo(
    () => mergeToolCalls(persistedToolCalls ?? [], liveToolCalls),
    [persistedToolCalls, liveToolCalls],
  );
  const contextCheckTrigger = useTriggerContextCheck(sessionId);

  // Trigger an immediate re-fetch of workflow runs when a background workflow
  // is started. The initial poll may have returned empty because the DB entry
  // is created a few seconds after the "workflow-started" SSE event fires.
  const workflowRunId = workflowSnapshot?.runId;
  useEffect(() => {
    if (workflowRunId) {
      void queryClient.invalidateQueries({
        queryKey: workflowRunsQueryKey(sessionId),
      });
    }
  }, [workflowRunId, sessionId, queryClient]);

  // Use the most recent run's snapshot if it has detail; fall back to a
  // minimal placeholder so the panel is visible for background workflows
  // whose snapshot hasn't been populated yet.
  const mostRecentRun = workflowRunsQuery.data?.[0];
  const persistedWorkflowSnapshot = mostRecentRun
    ? typeof mostRecentRun.snapshot?.name === "string" &&
      Array.isArray(mostRecentRun.snapshot?.agents)
      ? mostRecentRun.snapshot
      : {
          agentCount: 0,
          agents: [],
          doneCount: 0,
          errorCount: 0,
          name: `Workflow (${mostRecentRun.status})`,
          phases: [],
          runId: mostRecentRun.run_id,
          runningCount: mostRecentRun.status === "running" ? 1 : 0,
        }
    : undefined;

  // Synthetic snapshot for non-workflow sessions: shows the main agent as a
  // single node so the panel always has something to display.
  const sessionAgentSnapshot = useMemo((): WorkflowSnapshot => {
    const hasMessages = messages.length > 0;
    return {
      agentCount: 1,
      agents: [
        {
          id: 0,
          label: activeTool ? `${activeTool}…` : "Session agent",
          status: isActive ? "running" : hasMessages ? "done" : "queued",
        },
      ],
      doneCount: isActive ? 0 : hasMessages ? 1 : 0,
      errorCount: 0,
      name: "Session",
      phases: [],
      runningCount: isActive ? 1 : 0,
    };
  }, [isActive, messages.length, activeTool]);

  // After every 10th user prompt, trigger a background context-quality check.
  const prevPendingRef = useRef(false);
  useEffect(() => {
    const wasJustPending = prevPendingRef.current && !isActive;
    prevPendingRef.current = isActive;
    if (!wasJustPending) return;
    const userMsgCount = messages.filter((m) => m.role === "user").length;
    if (userMsgCount > 0 && userMsgCount % 10 === 0) {
      void contextCheckTrigger.mutate();
    }
  }, [isActive, messages, contextCheckTrigger]);

  // Track elapsed time while a prompt is in-flight.
  const startTimeRef = useRef<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (isActive) {
      if (!startTimeRef.current) startTimeRef.current = Date.now();
      const id = setInterval(
        () => setElapsedMs(Date.now() - (startTimeRef.current ?? Date.now())),
        500,
      );
      return () => clearInterval(id);
    }
    startTimeRef.current = null;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setElapsedMs(0);
  }, [isActive]);

  const elapsedLabel =
    elapsedMs >= 1000 ? `${(elapsedMs / 1000).toFixed(1)}s` : null;
  // Rough estimate: ~4 chars per token for output only. No cost yet — the real
  // usage (and its price) only arrives with the finished message.
  const estimatedTokens =
    streamingText.length > 0 ? Math.round(streamingText.length / 4) : null;

  const [selectedAgent, setSelectedAgent] = useState<{
    agentId: number;
    runId: string;
  } | null>(null);

  const handleAgentClick = useCallback((agentId: number, runId: string) => {
    setSelectedAgent({ agentId, runId });
  }, []);

  const errorMessage =
    streamError ??
    (messagesQuery.error instanceof Error
      ? messagesQuery.error.message
      : undefined);

  const handleSubmit = useCallback(
    async (
      message: PromptInputMessage,
      model: PromptEditorModel,
      tools: string[],
    ) => {
      if (!message.text.trim()) {
        return;
      }

      await promptMutation.mutateAsync({ model, text: message.text, tools });
    },
    [promptMutation],
  );

  const pendingPromptRef = useRef<{
    prompt: PendingPrompt | null;
    sessionId: string;
  } | null>(null);
  const submittedForRef = useRef<string | null>(null);

  // Submit the first prompt of a session, handed over by /sessions/new.
  //
  // The mutation is started from a timeout rather than inline. useMutation
  // attaches its observer to the mutation inside mutate() — that is the only
  // place it ever attaches — while React detaches it on unsubscribe and never
  // re-attaches. Starting the mutation during this commit means StrictMode's
  // teardown detaches the observer permanently: the mutation runs, dispatches
  // "success", and reaches nobody, so isPending stays true forever even though
  // the turn finished. Deferring past the commit leaves the subscription stable
  // by the time mutate() runs. The handoff is cleared when read, so it is
  // cached here for StrictMode's second effect pass.
  useEffect(() => {
    if (submittedForRef.current === sessionId) return;

    if (pendingPromptRef.current?.sessionId !== sessionId) {
      pendingPromptRef.current = {
        prompt: consumePendingPrompt(sessionId),
        sessionId,
      };
    }

    const pending = pendingPromptRef.current.prompt;
    if (!pending?.text.trim()) return;

    const timer = setTimeout(() => {
      submittedForRef.current = sessionId;
      if (pending.goal) {
        setGoal(pending.goal);
        void handleGoalSave(pending.goal);
      }
      // Rejections surface through the mutation's onError as streamError.
      promptMutation.mutateAsync(pending).catch(() => {});
    }, 0);

    return () => clearTimeout(timer);
    // promptMutation and handleGoalSave are deliberately omitted: they change
    // identity every render, and rescheduling the timer on each one could
    // starve it. Both are only read inside the timeout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [consumePendingPrompt, sessionId]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <SessionTopbar
        title={title}
        sessionId={sessionId}
        goal={goal}
        onGoalSave={handleGoalSave}
        messages={messages}
        onAgentClick={handleAgentClick}
        sessionRunning={isActive}
        snapshot={
          // Prefer the persisted snapshot (from DB/live polling) over the SSE
          // shell whenever they reference the same run and the persisted one
          // has at least as many agents. Background workflows emit an empty
          // "workflow-started" shell via SSE and never update it — the polling
          // snapshot has the real agent progress (including running agents
          // from the in-memory WorkflowManager).
          workflowSnapshot &&
          persistedWorkflowSnapshot &&
          workflowSnapshot.runId === persistedWorkflowSnapshot.runId &&
          persistedWorkflowSnapshot.agents.length >=
            workflowSnapshot.agents.length
            ? persistedWorkflowSnapshot
            : (workflowSnapshot ??
              persistedWorkflowSnapshot ??
              sessionAgentSnapshot)
        }
        toolCalls={toolCalls}
        workflowRuns={workflowRunsQuery.data}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-4 px-20 py-4">
        <AgentTranscriptDrawer
          agentId={selectedAgent?.agentId ?? null}
          onClose={() => setSelectedAgent(null)}
          open={selectedAgent !== null}
          runId={selectedAgent?.runId ?? null}
          sessionId={sessionId}
        />
        <Conversation className="min-h-0 w-full">
          <ConversationContent className="w-full">
            {messages.length === 0 ? (
              <ConversationEmptyState
                description="Send a message to start this session."
                icon={<MessageSquareIcon className="size-12" />}
                title="Start a conversation"
              />
            ) : (
              messages.map((message) => (
                <Message from={message.role} id={message.id} key={message.id}>
                  <MessageContent>
                    <MessageResponse>{message.text}</MessageResponse>
                  </MessageContent>
                </Message>
              ))
            )}
            {streamingText && (
              <Message from="assistant">
                <MessageContent>
                  <MessageResponse isAnimating>{streamingText}</MessageResponse>
                </MessageContent>
              </Message>
            )}
            {isActive && !streamingText && (
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <Spinner />
                <span>
                  {activeTool ? `Running ${activeTool}…` : "Thinking…"}
                </span>
                {elapsedLabel && (
                  <span className="tabular-nums">{elapsedLabel}</span>
                )}
                <TokenUsage approximate tokens={estimatedTokens} />
              </div>
            )}
            {errorMessage && (
              <p className="text-destructive text-sm">{errorMessage}</p>
            )}
          </ConversationContent>
          {/* {messages.length > 0 && (
          <ConversationDownload
            messages={
              messages.map((message) => ({
                id: message.id,
                parts: [{ text: message.text, type: "text" }],
                role: message.role,
              })) as UIMessage[]
            }
          />
        )} */}
          <ConversationScrollButton />
        </Conversation>
        {pendingQuestion && (
          <div className="shrink-0">
            <AskUserDialog
              payload={pendingQuestion}
              sessionId={sessionId}
              onDismiss={() => {}}
            />
          </div>
        )}
        <div className="shrink-0">
          <PromptEditor
            defaultTools={defaultTools}
            goalEditor={
              <GoalEditor goal={goal} onSave={handleGoalSave} variant="block" />
            }
            isRunning={isActive}
            onStop={handleStop}
            onSubmit={handleSubmit}
          />
        </div>
      </div>
      {wikiActive && <WikiMiniGraph />}
    </div>
  );
}
