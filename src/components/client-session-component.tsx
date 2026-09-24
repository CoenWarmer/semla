"use client";

import { useQueryClient } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useForkedSubmit } from "@/hooks/use-forked-submit";
import { usePendingPromptHandoff } from "@/hooks/use-pending-prompt-handoff";
import { usePeriodicContextCheck } from "@/hooks/use-periodic-context-check";
import { usePromptMutation } from "@/hooks/use-prompt-mutation";
import { useReviewPanelState } from "@/hooks/use-review-panel-state";
import { useSessionControls } from "@/hooks/use-session-controls";
import { useSessionComposition } from "@/hooks/use-session-composition";
import { useSessionHeader } from "@/hooks/use-session-header";
import {
  type SessionMessagesResult,
  useSessionMessages,
} from "@/hooks/use-session-messages";
import { useSessionSoundCue } from "@/hooks/use-session-sound-cue";
import { useSessionWorkflowSnapshots } from "@/hooks/use-session-workflow-snapshots";
import { isSessionMissing } from "@/lib/prompt-failure";
import { liveRoundMessages } from "@/lib/session/live-rounds";
import { mergeToolCalls } from "@/lib/session/live-tool-calls";
import { truncateAtMessage } from "@/lib/session/session-fork";
import {
  sessionAgentSelectionKey,
  sessionPendingScrollKey,
  useSessionAgentSelection,
  useSessionPendingScroll,
} from "@/lib/session/session-live-state";
import { appendConversation, groupConversation } from "@/lib/session/session-steps";

import { SessionConversation } from "./conversation/session-conversation";
import { ReviewPanel } from "./review/review-panel";
import { AgentTranscriptDrawer } from "./session/agent-transcript-drawer";
import { SessionLayout } from "./session/session-layout";
import { SessionSummaryPanel } from "./session/session-summary-panel";
import { SessionTopbar } from "./session/session-topbar";

const WikiMiniGraph = dynamic(
  () => import("./wiki/wiki-mini-graph").then((m) => m.WikiMiniGraph),
  { ssr: false },
);

export function ClientSessionComponent({
  defaultTools,
  goal: initialGoal,
  initialMessagesData,
  initialReviewManuallyOpened = false,
  isRunning,
  sessionId,
  title,
  turnStartedAt: initialTurnStartedAt,
}: {
  defaultTools: string[];
  goal?: string | null;
  initialMessagesData?: SessionMessagesResult;
  /**
   * Whether the operator had the review panel open when this session was
   * last viewed, from the session's own record on disk rather than local
   * state — a page load has no local state yet.
   */
  initialReviewManuallyOpened?: boolean;
  isRunning?: boolean;
  sessionId: string;
  title: string | null;
  /**
   * When the turn `isRunning` refers to started, from the session's own
   * record on disk. Anchors the activity line's elapsed-time counter so a
   * page refresh mid-turn keeps counting from the turn's real start instead
   * of restarting from zero.
   */
  turnStartedAt?: string | null;
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
  const queryClient = useQueryClient();

  const {
    activeTool,
    codeMap,
    isReconnecting,
    liveRounds,
    liveToolCalls,
    mutation: promptMutation,
    openReviewRequest,
    pendingFeatureSpec,
    pendingQuestion,
    serverIsRunning,
    serverTitle,
    serverTurnStartedAt,
    sessionExists,
    streamError,
    wikiActive,
    workflowSnapshot,
  } = usePromptMutation(
    sessionId,
    isRunning,
    viewingLeafId,
    initialTurnStartedAt,
  );

  /**
   * `useMutation` (TanStack Query) returns a fresh result object on every
   * render, so `promptMutation` is never the same object twice. `mutateAsync`
   * is bound once by the underlying `MutationObserver` and stays stable, so
   * everything that only needs to *call* the mutation takes this instead —
   * otherwise every callback closing over it, and every prop built from one
   * (e.g. `ReviewPanel`'s `onExplain`), would get a new identity every render.
   */
  const promptMutateAsync = promptMutation.mutateAsync;

  const { goal, saveGoal, saveTitle, shownTitle } = useSessionHeader({
    initialGoal,
    serverTitle,
    sessionId,
    title,
  });

  const { compact, stop } = useSessionControls(sessionId);

  const handleStop = useCallback(() => {
    // Fire and forget: the turn ends through the stream closing, and a failed
    // stop should not leave the button wedged. Errors surface in the log.
    stop();
  }, [stop]);

  const handleCompact = useCallback(() => {
    compact();
  }, [compact]);

  // The server's view counts too: a turn continues in the background after the
  // stream closes, and a dropped stream leaves this page with no local sign of
  // work that is still going.
  const isActive = promptMutation.isPending || isReconnecting || serverIsRunning;

  // Plays question.mp3 / done.mp3 when this session is not the tab in focus.
  useSessionSoundCue({
    hasPendingQuestion: pendingQuestion !== null || pendingFeatureSpec,
    isActive,
  });

  const review = useReviewPanelState({
    initialManuallyOpened: initialReviewManuallyOpened,
    isActive,
    openReviewRequest,
    sessionId,
  });

  const {
    forkedAt,
    handleCancelFork,
    handleEditPrompt,
    handleExplain,
    handleFork,
    handleSelectionChange,
    handleSubmit,
  } = useForkedSubmit({
    isActive,
    promptMutateAsync,
    reviewOpen: review.open,
    setReviewManuallyOpened: review.setManuallyOpened,
    viewingLeafId,
  });

  usePendingPromptHandoff({ promptMutateAsync, saveGoal, sessionId });

  // Paused mid-turn: the server has no rows for a turn until it ends, so an
  // unbidden refetch would replace the optimistic prompt with a list without it.
  const messagesQuery = useSessionMessages(
    sessionId,
    initialMessagesData,
    isActive,
    viewingLeafId,
  );
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
  // Persisted rows arrive only when the turn's entries are written, so fold in
  // the ones seen on the stream. Both are keyed by pi's tool call id, so a live
  // row becomes the persisted row rather than a second marker.
  const persistedToolCalls = messagesQuery.data?.toolCalls;
  const toolCalls = useMemo(
    () => mergeToolCalls(persistedToolCalls ?? [], liveToolCalls),
    [persistedToolCalls, liveToolCalls],
  );

  // What the context window holds, for the strip above the prompt bar.
  // Computed here rather than fetched: it is arithmetic over the transcript
  // this component already has, so asking a route for it would mean the
  // server re-reading and re-parsing the whole session for numbers the
  // browser was holding all along.
  const composition = useSessionComposition({ messages, messagesQuery, toolCalls });

  // Turns that only called tools carry no text and used to render as empty
  // bubbles. Folded into strips of steps instead — see session-steps.ts.
  //
  // Grouped in two parts so a streamed token regroups only the live tail. The
  // persisted part is grouped against the persisted calls alone, sorted the
  // way `mergeToolCalls` sorts them: a live call always points at a live
  // round's pseudo-message (see live-rounds.ts), never at a persisted one, so
  // the persisted part's grouping cannot depend on the live calls.
  const persistedConversation = useMemo(
    () => groupConversation(messages, mergeToolCalls(persistedToolCalls ?? [], [])),
    [messages, persistedToolCalls],
  );
  // One pseudo-message per assistant round trip this turn has made so far,
  // folded on after the persisted ones — so live text and live tool calls
  // interleave in the order the round trips actually happened, the same way
  // the persisted rows they become already do.
  const conversation = useMemo(
    () => appendConversation(persistedConversation, liveRoundMessages(liveRounds), toolCalls),
    [persistedConversation, liveRounds, toolCalls],
  );
  const liveTextLength = useMemo(
    () => liveRounds.reduce((sum, round) => sum + round.text.length, 0),
    [liveRounds],
  );

  usePeriodicContextCheck({ isActive, messages, sessionId });

  const workflowRunSnapshots = useSessionWorkflowSnapshots({
    activeTool,
    hasMessages: messages.length > 0,
    isActive,
    sessionId,
    workflowSnapshot,
  });

  /**
   * Whether the summary card is showing.
   *
   * Session-local rather than persisted, matching the review layout: the
   * card is a thing you glance at and dismiss, and a closed panel that stays
   * closed across reloads is harder to rediscover than one that comes back.
   */
  const [summaryOpen, setSummaryOpen] = useState(false);

  const selectedAgent = useSessionAgentSelection(sessionId).data;

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
      (messagesQuery.error instanceof Error ? messagesQuery.error.message : undefined));

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <SessionTopbar
        codeMap={codeMap}
        goal={goal}
        onGoalSave={saveGoal}
        onReviewClick={() => (review.open ? review.close() : review.setManuallyOpened(true))}
        onReviewLayoutChange={review.setLayout}
        onSummaryClick={() => setSummaryOpen((open) => !open)}
        onTitleSave={saveTitle}
        reviewCount={review.changedCount}
        reviewLayout={review.layout}
        reviewOpen={review.open}
        sessionId={sessionId}
        summaryOpen={summaryOpen}
        title={shownTitle}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-0 pb-1">
        <AgentTranscriptDrawer
          agentId={selectedAgent?.agentId ?? null}
          onClose={() => queryClient.setQueryData(sessionAgentSelectionKey(sessionId), null)}
          open={selectedAgent !== undefined}
          runId={selectedAgent?.runId ?? null}
          sessionId={sessionId}
        />
        <SessionLayout
          conversation={
            <SessionConversation
              activeTool={activeTool}
              composition={composition}
              conversation={conversation}
              defaultTools={defaultTools}
              errorMessage={errorMessage}
              forkedAt={forkedAt}
              goal={goal}
              hasMessages={messages.length > 0}
              isActive={isActive}
              liveTextLength={liveTextLength}
              turnStartedAt={serverTurnStartedAt}
              onCancelFork={handleCancelFork}
              onCompactClick={handleCompact}
              onEditPrompt={handleEditPrompt}
              onFork={handleFork}
              onGoalSave={saveGoal}
              onSelectionChange={handleSelectionChange}
              onStop={handleStop}
              onSubmit={handleSubmit}
              pendingFeatureSpec={pendingFeatureSpec}
              pendingQuestion={pendingQuestion}
              sessionId={sessionId}
              sessionMissing={sessionMissing}
              viewingLeafId={viewingLeafId}
              workflowRunSnapshots={workflowRunSnapshots}
              workflowSnapshot={workflowSnapshot}
            />
          }
          review={
            review.open ? (
              // No remount key: the panel is controlled, and remounting it for
              // each new pick would discard unsaved drafts, the hunk accordion
              // and the commit message — which the scrubber, which retargets
              // several times a second, would do constantly.
              <ReviewPanel
                leafId={viewingLeafId}
                onClose={review.close}
                onExplain={handleExplain}
                sessionId={sessionId}
                target={review.elementTarget}
              />
            ) : null
          }
          reviewLayout={review.layout}
          summary={
            summaryOpen ? (
              <SessionSummaryPanel
                goal={goal}
                model={messagesQuery.data?.model ?? null}
                onClose={() => setSummaryOpen(false)}
                sessionId={sessionId}
                snapshot={workflowSnapshot}
                title={shownTitle}
              />
            ) : null
          }
        />
      </div>

      {wikiActive && <WikiMiniGraph />}
    </div>
  );
}
