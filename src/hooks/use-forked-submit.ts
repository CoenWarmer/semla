import { useCallback, useEffect, useRef, useState } from "react";

import type { PromptInputMessage } from "@/components/ai-elements/prompt-input";
import type { PromptEditorModel } from "@/components/conversation/prompt-editor";
import type { usePromptMutation } from "@/hooks/use-prompt-mutation";

type PromptMutateAsync = ReturnType<typeof usePromptMutation>["mutation"]["mutateAsync"];
type PromptSelection = { model: PromptEditorModel; tools: string[] };

/**
 * Where the next prompt lands, and the four ways of sending one: the prompt
 * bar, an edited message, "Explain" from the review panel, and the fork
 * position that decides where the first of those continues from.
 */
export function useForkedSubmit({
  isActive,
  promptMutateAsync,
  reviewOpen,
  setReviewManuallyOpened,
  viewingLeafId,
}: {
  isActive: boolean;
  /** Stable for the mutation's lifetime, unlike the mutation result itself. */
  promptMutateAsync: PromptMutateAsync;
  reviewOpen: boolean;
  setReviewManuallyOpened: (next: boolean) => void;
  /** The branch the page is showing, from `?leaf=`; null for the live tip. */
  viewingLeafId: string | null;
}) {
  /**
   * The message a fork is currently positioned at, or null when the view is
   * the live tip. See docs/plans/branching-sessions.md §3: forking does not
   * itself create a branch, it repositions where the next prompt will land
   * — so until that prompt is sent, the only visible effect is that the
   * conversation is shown truncated to this point.
   */
  const [forkedAt, setForkedAt] = useState<string | null>(null);

  // Navigating to a different branch (§4) supersedes any in-progress fork
  // (§3) the operator had set up on whatever branch they were looking at
  // before — a fork position named against the old view has no meaning
  // against the new one. This mirrors an external value the URL controls,
  // not something that could be derived without an effect.
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    setForkedAt(null);
  }, [viewingLeafId]);

  // The model and tools the prompt bar would submit with. An edit or an
  // explanation runs a turn from somewhere other than the bar, and should use
  // the same selection.
  const selectionRef = useRef<PromptSelection | null>(null);
  const handleSelectionChange = useCallback((selection: PromptSelection | null) => {
    selectionRef.current = selection;
  }, []);

  const handleSubmit = useCallback(
    async (message: PromptInputMessage, model: PromptEditorModel, tools: string[]) => {
      if (!message.text.trim()) return;

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
      // Submitting a prompt while the review panel is on screen must not close
      // it. `shouldOpenReview`'s `sessionRunning` guard exists to stop the
      // panel *appearing* over a turn in progress, but this turn is about to
      // start with the panel already open — and an operator who is reading a
      // review while asking a question has not finished reading it.
      //
      // Recorded here, in the event handler, rather than derived: the flag is
      // the "the operator asked for this" signal, and submitting while open is
      // exactly that. Closing still dismisses, so this cannot strand the panel
      // open.
      if (reviewOpen) setReviewManuallyOpened(true);
      await promptMutateAsync({ leafId, model, text: message.text, tools });
    },
    [forkedAt, promptMutateAsync, reviewOpen, setReviewManuallyOpened, viewingLeafId],
  );

  /**
   * Fork the conversation at this message.
   *
   * Sets the position; nothing is sent yet, and nothing branches yet — see
   * docs/plans/branching-sessions.md §3. The next prompt (from the bar, an
   * edit, or "Explain") is what actually continues from here.
   */
  const handleFork = useCallback((entryId: string) => setForkedAt(entryId), []);
  const handleCancelFork = useCallback(() => setForkedAt(null), []);

  /**
   * Answer a question asked from the review panel.
   *
   * The panel is collapsed rather than dismissed: the answer arrives in the
   * conversation, which the review panel no longer shares the layout with once
   * collapsed, but the operator has not said they are finished reviewing — so
   * no fingerprint is recorded and the Review button still carries its count.
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
      promptMutateAsync({
        leafId: viewingLeafId ?? undefined,
        model: selection.model,
        text: prompt,
        tools: selection.tools,
      }).catch(() => {});
    },
    [promptMutateAsync, setReviewManuallyOpened, viewingLeafId],
  );

  const handleEditPrompt = useCallback(
    (entryId: string, text: string) => {
      const selection = selectionRef.current;
      // No model resolved yet, or a turn is already running — branching the leaf
      // under a live turn would interleave two paths in one session.
      if (!selection || isActive) return;

      // An edit names its own, more specific target (the edited entry's
      // parent) and takes priority over any fork position on the server — see
      // runPiPrompt. Clearing here keeps the client's display in step with
      // that: the truncation this fork was showing no longer applies once a
      // different leaf move has been made.
      setForkedAt(null);

      // Rejections surface through the mutation's onError as streamError.
      promptMutateAsync({
        editEntryId: entryId,
        model: selection.model,
        text,
        tools: selection.tools,
      }).catch(() => {});
    },
    [isActive, promptMutateAsync],
  );

  return {
    forkedAt,
    handleCancelFork,
    handleEditPrompt,
    handleExplain,
    handleFork,
    handleSelectionChange,
    handleSubmit,
  };
}
