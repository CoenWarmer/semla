"use client";

import type { PromptInputMessage } from "@/components/ai-elements/prompt-input";
import { usePromptMutation } from "@/hooks/use-prompt-mutation";
import { useDismissReview, useReview } from "@/hooks/use-review";
import {
  SessionMessagesResult,
  useSessionMessages,
} from "@/hooks/use-session-messages";
import { mergeToolCalls } from "@/lib/live-tool-calls";
import { liveRoundMessages } from "@/lib/live-rounds";
import { shouldOpenReview } from "@/lib/review-open";
import { useTriggerContextCheck } from "@/hooks/use-context-check";
import {
  useWorkflowRuns,
  workflowRunsQueryKey,
} from "@/hooks/use-workflow-runs";
import {
  sessionAgentSelectionKey,
  sessionPendingScrollKey,
  sessionRunningKey,
  sessionWorkflowComputedSnapshotKey,
  useSessionAgentSelection,
  useSessionPendingScroll,
} from "@/lib/session-live-state";
import type { WorkflowSnapshot } from "@/types/workflow";
import { AgentTranscriptDrawer } from "./agent-transcript-drawer";
import { useElementTarget } from "./element-target-provider";
import { ReviewPanel } from "./review/review-panel";
import { SessionConversation } from "./session-conversation";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "./ui/resizable";
import { truncateAtMessage } from "@/lib/session-fork";
import { groupConversation } from "@/lib/session-steps";
import dynamic from "next/dynamic";

const WikiMiniGraph = dynamic(
  () => import("./wiki/wiki-mini-graph").then((m) => m.WikiMiniGraph),
  { ssr: false },
);

import { isSessionMissing } from "@/lib/prompt-failure";

import type { PromptEditorModel } from "./prompt-editor";
import { latestInputTokens } from "@/lib/context-composition";
import { SessionTopbar } from "./session-topbar";
import {
  usePendingPrompt,
  type PendingPrompt,
} from "@/components/pending-prompt-provider";
import { useQueryClient } from "@tanstack/react-query";

import { SESSION_STATUS_KEY } from "@/lib/session-status";
import { useSessionSoundCue } from "@/hooks/use-session-sound-cue";
import { useSearchParams } from "next/navigation";
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
  initialMessagesData?: SessionMessagesResult;
  isRunning?: boolean;
  sessionId: string;
  title: string | null;
}) {
  /**
   * The branch this page is showing, from `?leaf=` — null for the default,
   * live view. Read here rather than in the server page: sessions/[id]/page.tsx
   * already runs a Supabase query and buildSessionMessages before it renders,
   * and re-running that whole payload on every branch click would turn a
   * client-side navigation into a full server round trip for a value the
   * client already fetches for itself. See
   * docs/plans/branching-sessions.md §4.
   */
  const searchParams = useSearchParams();
  const viewingLeafId = searchParams.get("leaf");

  const {
    activeTool,
    codeMap,
    isReconnecting,
    liveRounds,
    liveToolCalls,
    mutation: promptMutation,
    pendingQuestion,
    serverIsRunning,
    serverTitle,
    sessionExists,
    streamError,
    wikiActive,
    workflowSnapshot,
  } = usePromptMutation(sessionId, isRunning, viewingLeafId);

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

  const handleCompact = useCallback(() => {
    void fetch(`/api/sessions/${sessionId}/compact`, { method: "POST" }).catch(
      (error: unknown) => {
        console.warn("[session] compact failed:", error);
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

  // Plays question.mp3 / done.mp3 when this session is not the tab in focus.
  useSessionSoundCue({
    hasPendingQuestion: pendingQuestion !== null,
    isActive,
  });
  // Paused mid-turn: the server has no rows for a turn until it ends, so an
  // unbidden refetch would replace the optimistic prompt with a list without it.
  const messagesQuery = useSessionMessages(
    sessionId,
    initialMessagesData,
    isActive,
    viewingLeafId,
  );
  const workflowRunsQuery = useWorkflowRuns(sessionId, workflowSnapshot?.runId);
  /**
   * The message a fork is currently positioned at, or null when the view is
   * the live tip. See docs/plans/branching-sessions.md §3: forking does not
   * itself create a branch, it repositions where the next prompt will land
   * — so until that prompt is sent, the only visible effect is that the
   * conversation is shown truncated to this point.
   *
   * Cleared whenever the transcript query resolves to a *different* set of
   * messages than the one the fork was taken against: a real branch only
   * exists once a second child is appended, and once it does, the newly
   * fetched conversation already ends at the right place on its own —
   * continuing to truncate on the client would then cut off the very reply
   * the fork produced.
   */
  const [forkedAt, setForkedAt] = useState<string | null>(null);
  // Memoised, not just defaulted: `?? []` hands out a fresh array on every
  // render while the query is empty, which defeats every memo and effect
  // downstream that depends on it.
  const allMessages = useMemo(
    () => messagesQuery.data?.messages ?? [],
    [messagesQuery.data?.messages],
  );
  const messages = useMemo(
    () => truncateAtMessage(allMessages, forkedAt),
    [allMessages, forkedAt],
  );
  const costPerTurn = useMemo(() => {
    const rate = messagesQuery.data?.cacheReadRatePerMToken;
    if (rate == null) return null;
    const tokens = latestInputTokens(messages);
    if (tokens == null) return null;
    return (tokens * rate) / 1_000_000;
  }, [messages, messagesQuery.data?.cacheReadRatePerMToken]);
  const contextWindowFraction = useMemo(() => {
    const contextWindow = messagesQuery.data?.contextWindow;
    if (!contextWindow) return null;
    const tokens = latestInputTokens(messages);
    if (tokens == null) return null;
    return Math.min(1, tokens / contextWindow);
  }, [messages, messagesQuery.data?.contextWindow]);
  // Persisted rows arrive only when the turn's entries are written, so fold in
  // the ones seen on the stream. Both are keyed by pi's tool call id, so a live
  // row becomes the persisted row rather than a second marker.
  const persistedToolCalls = messagesQuery.data?.toolCalls;
  const toolCalls = useMemo(
    () => mergeToolCalls(persistedToolCalls ?? [], liveToolCalls),
    [persistedToolCalls, liveToolCalls],
  );
  // One pseudo-message per assistant round trip this turn has made so far,
  // appended after the persisted ones. A live tool call's messageId points at
  // one of these — see live-rounds.ts — so groupConversation interleaves live
  // text and live tool calls in the order the round trips actually happened,
  // the same way it already interleaves the persisted rows they become once
  // the turn ends. No separate live renderer and no placement hack: this and
  // `messages` are simply concatenated and handed to the one function that
  // already gets this right.
  const liveMessages = useMemo(
    () => liveRoundMessages(liveRounds),
    [liveRounds],
  );
  const messagesWithLiveRounds = useMemo(
    () => [...messages, ...liveMessages],
    [messages, liveMessages],
  );
  // Turns that only called tools carry no text and used to render as empty
  // bubbles. Folded into strips of steps instead — see session-steps.ts.
  const conversation = useMemo(
    () => groupConversation(messagesWithLiveRounds, toolCalls),
    [messagesWithLiveRounds, toolCalls],
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

  const snapshot =
    workflowSnapshot &&
    persistedWorkflowSnapshot &&
    workflowSnapshot.runId === persistedWorkflowSnapshot.runId &&
    persistedWorkflowSnapshot.agents.length >= workflowSnapshot.agents.length
      ? persistedWorkflowSnapshot
      : (workflowSnapshot ?? persistedWorkflowSnapshot ?? sessionAgentSnapshot);

  useEffect(() => {
    queryClient.setQueryData(
      sessionWorkflowComputedSnapshotKey(sessionId),
      snapshot,
    );
  }, [queryClient, sessionId, snapshot]);

  useEffect(() => {
    queryClient.setQueryData(sessionRunningKey(sessionId), isActive);
  }, [queryClient, sessionId, isActive]);

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
  // Rough estimate: ~4 chars per token for output only, across every round
  // trip this turn has made so far. No cost yet — the real usage (and its
  // price) only arrives with the finished message.
  const liveTextLength = useMemo(
    () => liveRounds.reduce((sum, round) => sum + round.text.length, 0),
    [liveRounds],
  );
  const estimatedTokens =
    liveTextLength > 0 ? Math.round(liveTextLength / 4) : null;

  const [reviewManuallyOpened, setReviewManuallyOpened] = useState(false);
  // Which way the review panel splits from the conversation when both are
  // open. "vertical" stacks them (review on top); "horizontal" sits them
  // side by side. Session-local rather than persisted: the choice matters
  // for exactly as long as this review is open.
  const [reviewLayout, setReviewLayout] = useState<"horizontal" | "vertical">(
    "horizontal",
  );
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
  const agentSelection = useSessionAgentSelection(sessionId);
  const selectedAgent = agentSelection.data;

  const pendingScrollQuery = useSessionPendingScroll(sessionId);
  /**
   * Fulfil a pending scroll once its target actually exists.
   *
   * Runs after every render, which is deliberately more often than the
   * conversation content changes — the check is cheap (one DOM lookup) and
   * the alternative, listing every value that could make the target appear
   * (query data, live rounds, forkedAt's truncation), is exactly the kind of
   * dependency array that silently misses one and stops firing.
   */
  useEffect(() => {
    const turnId = pendingScrollQuery.data;
    if (!turnId) return;

    const target = document.getElementById(turnId);
    if (!target) return;

    target.scrollIntoView({ behavior: "smooth", block: "center" });
    queryClient.setQueryData(sessionPendingScrollKey(sessionId), null);
  });

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

      // The branch this prompt continues from, when it is not the live tip.
      // A fork position (set by the fork button, within whatever branch is
      // currently open) takes priority over just viewing a branch through
      // ?leaf= — forking is the more specific of the two. Either way this is
      // self-healing if the named entry is stale by the time the turn lands:
      // resolveLeafOverride (session-leaf.ts) walks it forward to the current
      // tip of its branch rather than pinning the exact entry.
      //
      // Cleared regardless of outcome: on success the fetched conversation
      // already ends at the right place, and on failure there is nothing to
      // stay forked at — the prompt never landed. viewingLeafId is left alone
      // either way — it is the URL's concern, not this submission's.
      const leafId = forkedAt ?? viewingLeafId ?? undefined;
      setForkedAt(null);
      await promptMutation.mutateAsync({
        leafId,
        model,
        text: message.text,
        tools,
      });
    },
    [forkedAt, promptMutation, viewingLeafId],
  );

  /**
   * Fork the conversation at this message.
   *
   * Sets the position; nothing is sent yet, and nothing branches yet — see
   * docs/plans/branching-sessions.md §3. The next prompt (from the bar, an
   * edit, or "Explain") is what actually continues from here.
   */
  const handleFork = useCallback((entryId: string) => {
    setForkedAt(entryId);
  }, []);

  const handleCancelFork = useCallback(() => {
    setForkedAt(null);
  }, []);

  // Navigating to a different branch (§4) supersedes any in-progress fork
  // (§3) the operator had set up on whatever branch they were looking at
  // before — a fork position named against the old view has no meaning
  // against the new one. This mirrors an external value the URL controls,
  // not something the component could derive without an effect.
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    setForkedAt(null);
  }, [viewingLeafId]);

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
   * The panel is collapsed rather than dismissed: the answer arrives in the
   * conversation, which the review panel no longer shares the layout with once
   * collapsed, but the operator has not said they are finished reviewing — so
   * no fingerprint is recorded and the Review button still carries its count.
   *
   * Uses the prompt bar's own model and tool selection, exactly as an edited
   * message does.
   */
  const handleExplain = useCallback(
    (prompt: string) => {
      const selection = selectionRef.current;
      if (!selection) return;

      setReviewManuallyOpened(false);
      // A distinct turn from wherever the operator was forked to — explaining
      // an element is asked of the conversation as it stands, not of a fork
      // position that was set up but never sent.
      setForkedAt(null);
      // But NOT distinct from whatever branch is actually open: if the page is
      // showing an earlier branch (viewingLeafId, §4), that is the
      // conversation this prompt is asked of. Omitting it here would send the
      // turn to the session's live tip while this view stays keyed to the
      // branch it is showing (see usePromptMutation's messagesKey) — the
      // reply would land somewhere this screen never refetches, which reads
      // as "nothing happened" rather than as an answer that went missing.
      promptMutation
        .mutateAsync({
          leafId: viewingLeafId ?? undefined,
          model: selection.model,
          text: prompt,
          tools: selection.tools,
        })
        .catch(() => {});
    },
    [promptMutation, viewingLeafId],
  );

  const handleEditPrompt = useCallback(
    (entryId: string, text: string) => {
      const selection = selectionRef.current;
      // No model resolved yet, or a turn is already running — branching the leaf
      // under a live turn would interleave two paths in one session.
      if (!selection) return;

      // An edit names its own, more specific target (the edited entry's
      // parent) and takes priority over any fork position on the server — see
      // runPiPrompt. Clearing here keeps the client's display in step with
      // that: the truncation this fork was showing no longer applies once a
      // different leaf move has been made.
      setForkedAt(null);

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

  // Shared between the plain and review-split layouts below: the review
  // panel's resizable group is one of two places this can render, not two
  // different conversations.
  const conversationColumn = (
    <SessionConversation
      activeTool={activeTool}
      contextWindowFraction={contextWindowFraction}
      conversation={conversation}
      costPerTurn={costPerTurn}
      defaultTools={defaultTools}
      elapsedLabel={elapsedLabel}
      errorMessage={errorMessage}
      estimatedTokens={estimatedTokens}
      forkedAt={forkedAt}
      goal={goal}
      hasMessages={messages.length > 0}
      isActive={isActive}
      liveTextLength={liveTextLength}
      onCancelFork={handleCancelFork}
      onCompactClick={handleCompact}
      onEditPrompt={handleEditPrompt}
      onFork={handleFork}
      onGoalSave={handleGoalSave}
      onSelectionChange={handleSelectionChange}
      onStop={handleStop}
      onSubmit={handleSubmit}
      pendingQuestion={pendingQuestion}
      sessionId={sessionId}
      sessionMissing={sessionMissing}
      viewingLeafId={viewingLeafId}
    />
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <SessionTopbar
        onReviewClick={() =>
          reviewOpen ? closeReview() : setReviewManuallyOpened(true)
        }
        reviewCount={reviewChangedCount}
        reviewOpen={reviewOpen}
        reviewLayout={reviewLayout}
        onReviewLayoutChange={setReviewLayout}
        title={shownTitle}
        codeMap={codeMap}
        contextWindow={messagesQuery.data?.contextWindow ?? null}
        cacheReadRatePerMToken={messagesQuery.data?.cacheReadRatePerMToken}
        systemPromptChars={messagesQuery.data?.systemPromptChars}
        sessionId={sessionId}
        goal={goal}
        onGoalSave={handleGoalSave}
        messages={messages}
        sessionRunning={isActive}
        onCompactClick={handleCompact}
        toolCalls={toolCalls}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-0 pb-1">
        <AgentTranscriptDrawer
          agentId={selectedAgent?.agentId ?? null}
          onClose={() =>
            queryClient.setQueryData(sessionAgentSelectionKey(sessionId), null)
          }
          open={selectedAgent !== null}
          runId={selectedAgent?.runId ?? null}
          sessionId={sessionId}
        />
        {reviewOpen ? (
          <ResizablePanelGroup
            // Remounted on layout flip: react-resizable-panels otherwise
            // keeps the user's dragged percentages across orientations, so
            // an 80%-wide review pane would become an 80%-tall one instead
            // of resetting to a sane split for the new axis.
            className="min-h-0 flex-1"
            key={reviewLayout}
            orientation={reviewLayout}
          >
            <ResizablePanel
              className="flex min-h-0 flex-col overflow-hidden rounded-lg border"
              defaultSize={45}
              minSize={20}
            >
              <ReviewPanel
                // Remounts the panel for each new pick, which is what makes
                // `initialTarget` apply again — see its doc comment on
                // ReviewPanel. A plain open/close toggle has no such key
                // because there is only ever one "open" to render.
                key={elementTarget.target?.nonce ?? "manual"}
                initialTarget={elementTarget.target}
                onClose={closeReview}
                onExplain={handleExplain}
                sessionId={sessionId}
              />
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel
              className="flex min-h-0 flex-col overflow-hidden"
              defaultSize={55}
              minSize={20}
            >
              {conversationColumn}
            </ResizablePanel>
          </ResizablePanelGroup>
        ) : (
          conversationColumn
        )}
      </div>

      {wikiActive && <WikiMiniGraph />}
    </div>
  );
}
