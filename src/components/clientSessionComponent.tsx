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
import {
  useWorkflowRuns,
  workflowRunsQueryKey,
} from "@/hooks/use-workflow-runs";
import type { WorkflowSnapshot } from "@/types/workflow";
import { Spinner } from "@/components/ui/spinner";
import { AgentTranscriptDrawer } from "./agent-transcript-drawer";
import { PromptEditor, type PromptEditorModel } from "./prompt-editor";
import { SessionTopbar } from "./session-topbar";
import { MessageSquareIcon } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export function ClientSessionComponent({
  defaultTools,
  sessionId,
  title,
}: {
  defaultTools: string[];
  sessionId: string;
  title: string | null;
}) {
  const {
    activeTool,
    mutation: promptMutation,
    streamError,
    streamingText,
    workflowSnapshot,
  } = usePromptMutation(sessionId);

  const queryClient = useQueryClient();
  const messagesQuery = useSessionMessages(sessionId);
  const workflowRunsQuery = useWorkflowRuns(sessionId, workflowSnapshot?.runId);
  const messages = messagesQuery.data ?? [];

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
    const isActive = promptMutation.isPending;
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
  }, [promptMutation.isPending, messages.length, activeTool]);

  // Track elapsed time while a prompt is in-flight.
  const startTimeRef = useRef<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (promptMutation.isPending) {
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
  }, [promptMutation.isPending]);

  const elapsedLabel =
    elapsedMs >= 1000 ? `${(elapsedMs / 1000).toFixed(1)}s` : null;
  // Rough estimate: ~4 chars per token for output only.
  const estimatedTokens =
    streamingText.length > 0
      ? `~${Math.round(streamingText.length / 4).toLocaleString()} tokens`
      : null;

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

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <SessionTopbar
        title={title}
        sessionId={sessionId}
        messages={messages}
        onAgentClick={handleAgentClick}
        sessionRunning={promptMutation.isPending}
        snapshot={
          // When both snapshots reference the same run, prefer the one with
          // more agent data. Background workflows set workflowSnapshot to an
          // empty shell via "workflow-started" and never update it — the DB
          // polling snapshot has the real agent progress.
          workflowSnapshot &&
          persistedWorkflowSnapshot &&
          workflowSnapshot.runId === persistedWorkflowSnapshot.runId &&
          persistedWorkflowSnapshot.agents.length >
            workflowSnapshot.agents.length
            ? persistedWorkflowSnapshot
            : (workflowSnapshot ??
              persistedWorkflowSnapshot ??
              sessionAgentSnapshot)
        }
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
            {promptMutation.isPending && !streamingText && (
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <Spinner />
                <span>
                  {activeTool ? `Running ${activeTool}…` : "Thinking…"}
                </span>
                {elapsedLabel && (
                  <span className="tabular-nums">{elapsedLabel}</span>
                )}
                {estimatedTokens && (
                  <span className="tabular-nums">{estimatedTokens}</span>
                )}
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
        <div className="shrink-0">
          <PromptEditor defaultTools={defaultTools} onSubmit={handleSubmit} />
        </div>
      </div>
    </div>
  );
}
