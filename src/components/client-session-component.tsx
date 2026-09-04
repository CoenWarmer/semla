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
import { useDismissReview, useReview } from "@/hooks/use-review";
import { useSessionMessages } from "@/hooks/use-session-messages";
import { mergeToolCalls } from "@/lib/live-tool-calls";
import { shouldOpenReview } from "@/lib/review-open";
import { useTriggerContextCheck } from "@/hooks/use-context-check";
import {
  useWorkflowRuns,
  workflowRunsQueryKey,
} from "@/hooks/use-workflow-runs";
import type { WorkflowSnapshot } from "@/types/workflow";
import { AgentTranscriptDrawer } from "./agent-transcript-drawer";
import { useElementTarget } from "./element-target-provider";
import { ReviewPanel } from "./review/review-panel";
import { SessionActivityLine } from "@/components/session-activity-line";
import { AskUserDialog } from "./ask-user-dialog";
import { CopyMessageButton } from "./message-copy";
import { EditableUserMessage } from "./message-edit";
import { SessionStepsStrip } from "./session-steps-strip";
import { GoalEditor } from "./goal-editor";
import { groupConversation } from "@/lib/session-steps";
import dynamic from "next/dynamic";

const WikiMiniGraph = dynamic(
  () => import("./wiki/wiki-mini-graph").then((m) => m.WikiMiniGraph),
  { ssr: false },
);
import Link from "next/link";

import { isSessionMissing } from "@/lib/prompt-failure";

import { PromptEditor, type PromptEditorModel } from "./prompt-editor";
import { SessionTopbar } from "./session-topbar";
import { MessageSquareIcon } from "lucide-react";
import {
  usePendingPrompt,
  type PendingPrompt,
} from "@/components/pending-prompt-provider";
import { useQueryClient } from "@tanstack/react-query";

import { SESSION_STATUS_KEY } from "@/lib/session-status";
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
    codeMap,
    isReconnecting,
    liveToolCalls,
    mutation: promptMutation,
    pendingQuestion,
    serverIsRunning,
    serverTitle,
    sessionExists,
    streamError,
    streamingText,
    wikiActive,
    spans,
    workflowSnapshot,
  } = usePromptMutation(sessionId, isRunning);

  const { consume: consumePendingPrompt } = usePendingPrompt();

  /**
   * The session's title.
   *
   * `title` is the server's render, which for a session created by its own
   * first prompt is null — the title is derived from that prompt while the turn
   * runs, and arrives over the stream. Rendering it from here is what replaced
   * a `router.refresh()` after the turn: a full root-layout re-render, measured
   * at ~4s, to propagate one string.
   */
  const shownTitle = serverTitle ?? title;
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

  const handleGoalSave = useCallback(
    async (next: string | null) => {
      setGoal(next);
      await fetch(`/api/sessions/${sessionId}`, {
        body: JSON.stringify({ goal: next ?? "" }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
    },
    [sessionId],
  );

  const queryClient = useQueryClient();
  // The server's view counts too: a turn continues in the background after the
  // stream closes, and a dropped stream leaves this page with no local sign of
  // work that is still going.
  const isActive =
    promptMutation.isPending || isReconnecting || serverIsRunning;
  // Paused mid-turn: the server has no rows for a turn until it ends, so an
  // unbidden refetch would replace the optimistic prompt with a list without it.
  const messagesQuery = useSessionMessages(
    sessionId,
    initialMessagesData,
    isActive,
  );
  const workflowRunsQuery = useWorkflowRuns(sessionId, workflowSnapshot?.runId);
  // Memoised, not just defaulted: `?? []` hands out a fresh array on every
  // render while the query is empty, which defeats every memo and effect
  // downstream that depends on it.
  const messages = useMemo(
    () => messagesQuery.data?.messages ?? [],
    [messagesQuery.data?.messages],
  );
  // Persisted rows arrive only when the turn's entries are written, so fold in
  // the ones seen on the stream. Both are keyed by pi's tool call id, so a live
  // row becomes the persisted row rather than a second marker.
  const persistedToolCalls = messagesQuery.data?.toolCalls;
  const toolCalls = useMemo(
    () => mergeToolCalls(persistedToolCalls ?? [], liveToolCalls),
    [persistedToolCalls, liveToolCalls],
  );
  // Turns that only called tools carry no text and used to render as empty
  // bubbles. Folded into strips of steps instead — see session-steps.ts.
  const conversation = useMemo(
    () => groupConversation(messages, toolCalls),
    [messages, toolCalls],
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
      contextCheckTrigger.mutate();
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
    // oxlint-disable-next-line react/set-state-in-effect
    setElapsedMs(0);
  }, [isActive]);

  const elapsedLabel =
    elapsedMs >= 1000 ? `${(elapsedMs / 1000).toFixed(1)}s` : null;
  // Rough estimate: ~4 chars per token for output only. No cost yet — the real
  // usage (and its price) only arrives with the finished message.
  const estimatedTokens =
    streamingText.length > 0 ? Math.round(streamingText.length / 4) : null;

  const [reviewManuallyOpened, setReviewManuallyOpened] = useState(false);
  // The badge is worth a request even with the panel shut: it is how the
  // operator learns there is something to review without being interrupted.
  const reviewQuery = useReview(sessionId);
  const dismissReview = useDismissReview(sessionId);
  const reviewChangedCount = (reviewQuery.data?.projects ?? []).reduce(
    (sum, project) => sum + project.changedFiles.length,
    0,
  );

  /**
   * A source location the element picker resolved, waiting to be opened.
   *
   * Read from context rather than a prop: the picker lives in `HeaderActions`,
   * a sibling of this component under the root layout rather than an ancestor,
   * so nothing here can receive it as one. See element-target-provider.tsx.
   */
  const elementTarget = useElementTarget();

  // Derived, never set from an effect. `react/set-state-in-effect` is an
  // error in this repository, and the panel is genuinely open *because of* the
  // state rather than because something once happened to it. A picked element
  // opens the panel exactly like the manual button does, just from a
  // different origin for the "the operator asked for this" signal.
  const reviewOpen =
    shouldOpenReview({
      manuallyOpened: reviewManuallyOpened,
      review: reviewQuery.data,
      sessionRunning: isActive,
    }) || elementTarget.target !== null;

  // Closing is also dismissing. Without recording the state as seen, the next
  // refetch would find it unreviewed and open the panel straight back up.
  const closeReview = useCallback(() => {
    setReviewManuallyOpened(false);
    elementTarget.clear();
    const seen = reviewQuery.data?.fingerprint;
    if (seen) dismissReview.mutate(seen);
  }, [dismissReview, elementTarget, reviewQuery.data?.fingerprint]);
  const [selectedAgent, setSelectedAgent] = useState<{
    agentId: number;
    runId: string;
  } | null>(null);

  const handleAgentClick = useCallback((agentId: number, runId: string) => {
    setSelectedAgent({ agentId, runId });
  }, []);

  // Why this is the test, and why it does not flash on a legitimate ?new=1
  // page, is in `isSessionMissing`.
  const sessionMissing = isSessionMissing({
    exists: sessionExists,
    promptErrored: promptMutation.isError,
    promptIdle: promptMutation.isIdle,
  });

  const errorMessage = sessionMissing
    ? undefined
    : (streamError ??
      (messagesQuery.error instanceof Error
        ? messagesQuery.error.message
        : undefined));

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

  // The model and tools the prompt bar would submit with. An edit runs a turn
  // from a message rather than from the bar, and should use the same selection.
  const selectionRef = useRef<{
    model: PromptEditorModel;
    tools: string[];
  } | null>(null);
  const handleSelectionChange = useCallback(
    (selection: { model: PromptEditorModel; tools: string[] } | null) => {
      selectionRef.current = selection;
    },
    [],
  );

  /**
   * Answer a question asked from the review panel.
   *
   * The overlay is hidden rather than dismissed: the answer arrives in the
   * conversation underneath it, which cannot be read through a panel, but the
   * operator has not said they are finished reviewing — so no fingerprint is
   * recorded and the Review button still carries its count.
   *
   * Uses the prompt bar's own model and tool selection, exactly as an edited
   * message does.
   */
  const handleExplain = useCallback(
    (prompt: string) => {
      const selection = selectionRef.current;
      if (!selection) return;

      setReviewManuallyOpened(false);
      promptMutation
        .mutateAsync({
          model: selection.model,
          text: prompt,
          tools: selection.tools,
        })
        .catch(() => {});
    },
    [promptMutation],
  );

  const handleEditPrompt = useCallback(
    (entryId: string, text: string) => {
      const selection = selectionRef.current;
      // No model resolved yet, or a turn is already running — branching the leaf
      // under a live turn would interleave two paths in one session.
      if (!selection) return;

      // Rejections surface through the mutation's onError as streamError.
      promptMutation
        .mutateAsync({
          editEntryId: entryId,
          model: selection.model,
          text,
          tools: selection.tools,
        })
        .catch(() => {});
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

      // `pending.create` rides along in the request: the session may not exist
      // yet, and the prompt route creates it before running the turn. Creating
      // it from here first would put a second round trip between arriving on
      // this page and the agent starting.
      //
      // Rejections surface through the mutation's onError as streamError.
      promptMutation.mutateAsync(pending).catch(() => {});

      if (pending.create) {
        // The sidebar polls; nudge it so the new session appears now rather
        // than whenever the next poll lands.
        void queryClient.invalidateQueries({ queryKey: SESSION_STATUS_KEY });
      }
    }, 0);

    return () => clearTimeout(timer);
    // promptMutation and handleGoalSave are deliberately omitted: they change
    // identity every render, and rescheduling the timer on each one could
    // starve it. Both are only read inside the timeout.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [consumePendingPrompt, sessionId]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <SessionTopbar
        onReviewClick={() =>
          reviewOpen ? closeReview() : setReviewManuallyOpened(true)
        }
        reviewCount={reviewChangedCount}
        reviewOpen={reviewOpen}
        title={shownTitle}
        codeMap={codeMap}
        contextWindow={messagesQuery.data?.contextWindow ?? null}
        systemPromptChars={messagesQuery.data?.systemPromptChars}
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
        spans={spans}
        toolCalls={toolCalls}
        workflowRuns={workflowRunsQuery.data}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-4 px-20 py-4">
        {reviewOpen && (
          <ReviewPanel
            // Remounts the panel for each new pick, which is what makes
            // `initialTarget` apply again — see its doc comment on
            // ReviewPanel. A plain open/close toggle has no such key because
            // there is only ever one "open" to render.
            key={elementTarget.target?.nonce ?? "manual"}
            initialTarget={elementTarget.target}
            onClose={closeReview}
            onExplain={handleExplain}
            sessionId={sessionId}
          />
        )}

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
              conversation.map((item) =>
                item.kind === "steps" ? (
                  <SessionStepsStrip items={item.items} key={item.id} />
                ) : (
                  item.message.role === "user" ? (
                    // Renders its own Message and bubble, so the edit button
                    // can sit beside the bubble rather than inside it.
                    <EditableUserMessage
                      disabled={isActive}
                      key={item.message.id}
                      message={item.message}
                      onSubmit={handleEditPrompt}
                    />
                  ) : (
                    <Message
                      from={item.message.role}
                      id={item.message.id}
                      key={item.message.id}
                    >
                      {/*
                        An assistant reply is left-aligned, so its gutter is on
                        the right — the mirror of the user row in
                        message-edit.tsx, which puts its buttons on the left.
                      */}
                      <div className="group/message flex items-start gap-2">
                        <MessageContent>
                          <MessageResponse>{item.message.text}</MessageResponse>
                        </MessageContent>
                        <CopyMessageButton
                          className="mt-1"
                          text={item.message.text}
                        />
                      </div>
                    </Message>
                  )
                ),
              )
            )}
            {streamingText && (
              <Message from="assistant">
                <MessageContent>
                  <MessageResponse isAnimating>{streamingText}</MessageResponse>
                </MessageContent>
              </Message>
            )}
            {/*
              `active` is the same value the prompt bar gets as `isRunning`
              below. Passing one signal to both is what stops the stop button
              and this line disagreeing about whether anything is happening.
            */}
            <SessionActivityLine
              active={isActive}
              activeTool={activeTool}
              elapsedLabel={elapsedLabel}
              estimatedTokens={estimatedTokens}
              streaming={streamingText.length > 0}
            />
            {errorMessage && (
              <p className="text-destructive text-sm">{errorMessage}</p>
            )}
            {sessionMissing && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm">
                <p className="font-medium">This session was never created.</p>
                <p className="mt-1 text-muted-foreground">
                  Its first prompt is what brings a session into being, and that
                  prompt never reached the server — most likely the page was
                  reloaded before it was sent. Prompts typed here cannot create
                  it, so they will keep failing.
                </p>
                <Link
                  className="mt-3 inline-block underline hover:no-underline"
                  href="/sessions/new"
                >
                  Start a new session
                </Link>
              </div>
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
              <GoalEditor
                /* Compact: it sits in the footer's tool row now, beside the
                   attachment and tool buttons, where the bordered block
                   variant was a full-width box among small controls. */
                variant="inline"
                autoFocus={!goal?.trim()}
                goal={goal}
                onSave={handleGoalSave}
              />
            }
            /* Same signal as SessionActivityLine above. */
            isRunning={isActive}
            onSelectionChange={handleSelectionChange}
            onStop={handleStop}
            onSubmit={handleSubmit}
            sessionId={sessionId}
          />
        </div>
      </div>
      {wikiActive && <WikiMiniGraph />}
    </div>
  );
}
