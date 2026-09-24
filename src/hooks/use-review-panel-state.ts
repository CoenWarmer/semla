import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useElementTarget } from "@/components/element-target-provider";
import {
  allReviewCommentsQueryKey,
  reviewCommentsQueryKey,
  useDismissReview,
  useReview,
} from "@/hooks/use-review";
import { followModeEnabled, useUserSettings } from "@/hooks/use-user-settings";
import type { ReviewComment } from "@/lib/review/review-comment-types";
import { openingWrite, shouldFollowOpen, shouldOpenReview } from "@/lib/review/review-open";
import { patchSession } from "@/lib/session/patch-session";
import { useSessionLiveAccesses } from "@/lib/session/session-live-state";
import type { TurnStreamState } from "@/lib/session/turn-stream-reducer";

/**
 * Whether the review panel is on screen, and everything that decides it.
 *
 * Held above the panel rather than in it because the panel does not exist
 * while it is closed, which is precisely the state this decides.
 */
export function useReviewPanelState({
  initialManuallyOpened,
  isActive,
  openReviewRequest,
  sessionId,
}: {
  initialManuallyOpened: boolean;
  /** A turn is in flight — the panel does not *appear* over one. */
  isActive: boolean;
  /** An `open_review` tool call, arriving over the stream. */
  openReviewRequest: TurnStreamState["openReviewRequest"];
  sessionId: string;
}) {
  const queryClient = useQueryClient();

  const [manuallyOpened, setManuallyOpenedState] = useState(initialManuallyOpened);
  // Persisted to the session's own record on disk, not to per-user panel
  // layout: this is "was review open in *this* session", which belongs beside
  // the session's other saved view state (leafId) rather than beside a
  // pixel size that would be the same for every session.
  const setManuallyOpened = useCallback(
    (next: boolean) => {
      setManuallyOpenedState(next);
      void patchSession(sessionId, { reviewManuallyOpened: next }).catch((error: unknown) => {
        console.warn("[session] saving review state failed:", error);
      });
    },
    [sessionId],
  );

  // Which way the review panel splits from the conversation when both are
  // open. "vertical" stacks them (review on top); "horizontal" sits them
  // side by side. Session-local rather than persisted: the choice matters
  // for exactly as long as this review is open.
  const [layout, setLayout] = useState<"horizontal" | "vertical">("horizontal");

  // The badge is worth a request even with the panel shut: it is how the
  // operator learns there is something to review without being interrupted.
  const reviewQuery = useReview(sessionId);
  const changedCount = (reviewQuery.data?.projects ?? []).reduce(
    (sum, project) => sum + project.changedFiles.length,
    0,
  );

  /**
   * A source location the element picker resolved, waiting to be opened.
   *
   * Read from context rather than a prop: the picker lives in `HeaderActions`,
   * a sibling of the session page under the root layout rather than an
   * ancestor, so nothing here can receive it as one. See
   * element-target-provider.tsx.
   */
  const elementTarget = useElementTarget();

  // The live write that may put the panel on screen, and the one already
  // dismissed.
  const userSettings = useUserSettings();
  const liveAccesses = useSessionLiveAccesses(sessionId).data;
  const [dismissedWriteId, setDismissedWriteId] = useState<string | null>(null);
  const followWrite = useMemo(() => openingWrite(liveAccesses ?? []), [liveAccesses]);

  // Derived, never set from an effect. `react/set-state-in-effect` is an
  // error in this repository, and the panel is genuinely open *because of* the
  // state rather than because something once happened to it. A picked element
  // opens the panel exactly like the manual button does, just from a
  // different origin for the "the operator asked for this" signal.
  const open =
    shouldOpenReview({
      manuallyOpened,
      review: reviewQuery.data,
      sessionRunning: isActive,
    }) ||
    elementTarget.target !== null ||
    shouldFollowOpen({
      dismissedId: dismissedWriteId,
      followMode: followModeEnabled(userSettings.data),
      write: followWrite,
    });

  // Closing is also dismissing. Without recording the state as seen, the next
  // refetch would find it unreviewed and open the panel straight back up.
  //
  // Depends on `mutate` rather than the mutation: `useMutation` returns a
  // fresh result object on every render, while `mutate` is bound once by the
  // MutationObserver. Depending on the object gave `ReviewPanel`'s `onClose`
  // a new identity every render — the exact case `React.memo` cannot help with.
  const dismissReview = useDismissReview(sessionId).mutate;
  const close = useCallback(() => {
    setManuallyOpened(false);
    elementTarget.clear();
    // Closing a follow-opened panel mid-turn has to stick, or the agent's next
    // edit reopens it and the close button is useless. Recording the write
    // rather than a flag is what still lets a *later* edit open it again.
    setDismissedWriteId(followWrite?.id ?? null);
    const seen = reviewQuery.data?.fingerprint;
    if (seen) dismissReview(seen);
  }, [
    dismissReview,
    elementTarget,
    followWrite?.id,
    reviewQuery.data?.fingerprint,
    setManuallyOpened,
  ]);

  // The `open_review` tool asks the panel to open the same way a picked
  // element or an artifact chip does — through `elementTarget.request()` —
  // but the request arrives over the stream rather than from a DOM click, so
  // there is no event handler to call it from. The nonce is what makes a
  // *repeated* request (e.g. two "just open, nothing selected" calls in a
  // row) still take effect: without it, a second identical request would be
  // the same object as the last one this effect already acted on.
  //
  // Calling `elementTarget.request` here is not itself the state this effect
  // reacts to — it sets ElementTargetProvider's state, not this hook's — so it
  // is not the pattern `react/set-state-in-effect` exists to catch.
  const openReviewRequestNonce = openReviewRequest?.nonce;
  useEffect(() => {
    if (openReviewRequestNonce === undefined) return;
    const target = openReviewRequest?.target;

    // A comment this same call created is already durable (open-review.ts
    // inserted it before returning), so it only needs to reach the editor
    // pane's query cache — not a re-fetch of the route it will read from on
    // the next mount, which is what a comment from a *previous* turn relies
    // on instead. Appended, matching `listReviewComments`' oldest-first
    // order: this comment was created after everything already cached.
    const comment = openReviewRequest?.comment;
    if (comment && target) {
      queryClient.setQueryData<ReviewComment[]>(
        reviewCommentsQueryKey(sessionId, target.project, target.path),
        (previous) => [...(previous ?? []), comment],
      );
      // And the session-wide sequence the comment cards' arrows step
      // through, for the same reason the batch path appends to it: a
      // comment the arrows cannot reach is one the operator can only find
      // by opening its file by hand.
      queryClient.setQueryData<ReviewComment[]>(
        allReviewCommentsQueryKey(sessionId),
        (previous) => [...(previous ?? []), comment],
      );
    }

    if (target === null || target === undefined) {
      // No path to open at — just bring the panel on screen, the same way
      // the header's Review button does.
      setManuallyOpened(true);
      return;
    }
    elementTarget.request({
      commitSha: target.commitSha ?? null,
      line: target.line ?? undefined,
      path: target.path,
      precision: "exact",
      project: target.project,
    });
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [openReviewRequestNonce]);

  return {
    changedCount,
    close,
    elementTarget: elementTarget.target,
    layout,
    open,
    setLayout,
    setManuallyOpened,
  };
}
