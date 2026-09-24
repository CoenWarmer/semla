"use client";

/**
 * Which file the review panel shows, and where in it.
 *
 * Four sources can each claim the panel: an external `PanelTarget` (the
 * element picker, a scrubber step, an artifact chip via `openStep`/
 * `openWorkspacePath`), the panel's own navigation (a sidebar click, an
 * arrow key), agent-follow mode, and a captured hunk anchor re-matched
 * against the live diff. This hook is the seam where those four are
 * reconciled into one answer — extracted out of `ReviewPanel` because the
 * reconciliation is itself a non-trivial algorithm (the precedence order,
 * `overNonce` bookkeeping, the follow-mode derivation, anchor re-matching)
 * that deserves a name and a test surface of its own, distinct from the
 * panel's layout and DOM concerns.
 *
 * The pure rules this composes — `activeRequest`/`baseRequestFor` in
 * review-panel-request.ts, `anchorRevealRequest` in review-anchor-reveal.ts,
 * `activeCommitSha` in review-artifact-commit.ts — are unchanged and still
 * independently tested there. This hook is the composition, not a
 * reimplementation.
 */

import { useCallback, useMemo, useState } from "react";

import { revealLineFor, type ScrubberStop } from "@/lib/pi/file-access/access-sequence";
import { useReview, useReviewHunks } from "@/hooks/use-review";
import {
  followModeEnabled,
  useUpdateFollowMode,
  useUserSettings,
} from "@/hooks/use-user-settings";
import type { ReviewComment } from "@/lib/review/review-comment-types";
import type { SessionReview } from "@/lib/review/review-types";
import { useSessionLiveAccesses } from "@/lib/session/session-live-state";

import { agentLabelFor } from "./review-access-labels";
import { anchorRevealRequest } from "./review-anchor-reveal";
import { activeCommitSha, BLANK_COMMIT_SELECTION } from "./review-artifact-commit";
import type { FileSelection } from "./review-changed-files";
import { selectionForWorkspacePath } from "./review-definition-target";
import {
  canGoBack,
  canGoForward,
  currentFileHistoryEntry,
  goBack as stepHistoryBack,
  goForward as stepHistoryForward,
  INITIAL_FILE_HISTORY,
  pushFileHistory,
  type FileHistoryState,
} from "./review-file-history";
import {
  activeRequest,
  baseRequestFor,
  nextReveal,
  type AccessHighlight,
  type PanelRequest,
  type PanelTarget,
} from "./review-panel-request";

/**
 * The first thing worth showing: the anchor project's first changed file.
 *
 * Derived during render rather than pushed into state by an effect. Choosing
 * a default in an effect is the `react/set-state-in-effect` error this
 * repository treats as fatal, and it also flashes an empty pane for a frame.
 */
function defaultSelection(review: SessionReview | undefined): FileSelection | null {
  for (const project of review?.projects ?? []) {
    const first = project.changedFiles[0];
    if (first) return { path: first.path, project: project.path };
  }
  return null;
}

export interface PanelTargetState {
  /** The file to show in the editor, or null when there is nothing to show. */
  selection: FileSelection | null;
  /**
   * `selection`, but null when it came from `defaultSelection` rather than
   * from an actual request. `highlight` describes the file a request named,
   * not whichever one the panel happened to fall back to showing, so a
   * caller that only wants to mark lines when the highlight truly matches
   * the open file compares against this rather than `selection`.
   */
  requestedSelection: FileSelection | null;
  /** The changed file whose hunks are folded open in the sidebar. */
  expanded: FileSelection | null;
  reveal: { line: number; nonce: number } | null;
  highlight: AccessHighlight | null;
  precision: "exact" | "component" | null;
  /** The commit selected in `ReviewCommitNav`, or null for the working tree. */
  selectedCommitSha: string | null;
  setSelectedCommitSha: (sha: string | null) => void;
  /** A line to scroll to, distinct from whatever is already showing. */
  revealLine: (line: number) => void;
  /** Open a file by clicking it, folding its hunks open and clearing any highlight. */
  selectFile: (next: FileSelection | null) => void;
  /**
   * Click a row in the changed-files sidebar: opens the file, but toggles
   * the hunk accordion shut when the click landed on the file already
   * expanded, rather than reopening it — the click is already the open
   * editor selection, so re-expanding would be a no-op that reads as one.
   */
  selectFileFromSidebar: (next: FileSelection) => void;
  /**
   * Open a workspace-relative path, which is how Go to Definition answers.
   * Returns an error message when the path is outside every project this
   * session is linked to, so the caller can surface it — this hook has no
   * route of its own to a notice banner.
   */
  openWorkspacePath: (path: string, line: number) => { error: string } | null;
  /** Open a scrubber stop: a tool call, or a file the agent touched. */
  openStep: (stop: ScrubberStop) => void;
  /**
   * Open the file a review comment is on, and scroll to its first line —
   * what a comment card's next/previous arrows do.
   */
  openComment: (comment: ReviewComment) => void;
  /** Whether the panel is currently following the agent's live writes. */
  following: boolean;
  /** Turn following on or off — a saved preference, not a per-step unpin. */
  changeFollowing: (next: boolean) => void;
  /**
   * Back/forward through the files the operator explicitly opened —
   * `selectFile`, `selectFileFromSidebar`, `openWorkspacePath`, `openStep`,
   * `openComment`. Agent-follow-mode switches are not history entries, so
   * these never step through a file the operator did not themselves visit.
   *
   * `canGoBack`/`canGoForward` say whether the corresponding step is
   * possible; `goBack`/`goForward` are no-ops when it is not, so a caller
   * that forgets to check first still cannot misbehave.
   */
  canGoBack: boolean;
  canGoForward: boolean;
  goBack: () => void;
  goForward: () => void;
}

/**
 * Reconcile the four sources above into one settled answer.
 *
 * Fetches its own review and hunks data — `useReview(sessionId)` here and in
 * `ReviewPanel` are deduped by React Query into one request, so nothing here
 * costs a second network round trip. Hunks specifically have to be fetched
 * here rather than passed in: anchor re-matching needs the live hunks of
 * whatever file is *about to be shown*, which this hook is the one place
 * that knows before the caller does.
 */
export function usePanelTarget(
  sessionId: string,
  target: PanelTarget | null | undefined,
): PanelTargetState {
  const review = useReview(sessionId);

  /**
   * Where the panel has navigated itself — a sidebar click, a scrubber step.
   *
   * Stale by construction once a newer `target` arrives, which is what
   * removes the need to sync the prop into state from an effect.
   */
  const [ownRequest, setOwnRequest] = useState<PanelRequest | null>(null);
  const chosenRequest = useMemo(
    () => activeRequest(ownRequest, target),
    [ownRequest, target],
  );

  /**
   * Back/forward history of explicitly opened files.
   *
   * Only the operator's own deliberate opens ever reach `recordHistory` —
   * see the call sites below. Agent-follow mode derives `followRequest`
   * straight from live accesses without going through `revise` at all, so
   * it never grows this stack; a fast-moving agent turn would otherwise
   * fill it with files the operator never chose to visit.
   */
  const [history, setHistory] = useState<FileHistoryState>(
    INITIAL_FILE_HISTORY,
  );
  const recordHistory = useCallback(
    (next: FileSelection | null) =>
      setHistory((previous) => pushFileHistory(previous, next)),
    [],
  );

  /**
   * A commit artifact chip names a commit to select in `ReviewCommitNav`.
   * Same precedence rule as `chosenRequest`, applied to this one extra field
   * a target can carry — see review-artifact-commit.ts.
   */
  const [ownCommitSelection, setOwnCommitSelection] = useState(
    BLANK_COMMIT_SELECTION,
  );
  const selectedCommitSha = activeCommitSha(ownCommitSelection, target);
  const setSelectedCommitSha = useCallback(
    (sha: string | null) =>
      setOwnCommitSelection({ overNonce: target?.nonce ?? 0, sha }),
    [target],
  );

  /**
   * Navigate the panel, starting from whatever it is showing now.
   *
   * Stamping `overNonce` here rather than at each call site is what keeps the
   * precedence rule in one place: every self-made request is automatically
   * marked as having been made against the current external target.
   */
  const revise = useCallback(
    (change: (base: PanelRequest) => Partial<PanelRequest>) =>
      setOwnRequest((previous) => {
        const base = activeRequest(previous, target);
        return { ...base, ...change(base), overNonce: target?.nonce ?? 0 };
      }),
    [target],
  );

  // The counter is what makes asking for the same line twice two requests
  // rather than one unchanged prop.
  const revealLine = useCallback(
    (line: number) => revise((base) => ({ reveal: nextReveal(base, line) })),
    [revise],
  );

  // Selecting a file opens it in the editor and folds its hunks open in the
  // sidebar — one click, not two. A null selection (the project-tab switch
  // when a project has no changed files) closes the accordion too, since
  // there is nothing left to have open.
  //
  // The agent's read highlight is dropped: it described the file the
  // scrubber was on, and leaving it behind would mark lines of a file the
  // agent may never have opened.
  const selectFile = useCallback(
    (next: FileSelection | null) => {
      recordHistory(next);
      revise(() => ({
        expanded: next,
        highlight: null,
        precision: null,
        selection: next,
      }));
    },
    [recordHistory, revise],
  );

  const selectFileFromSidebar = useCallback(
    (next: FileSelection) => {
      recordHistory(next);
      revise((base) => ({
        expanded:
          base.expanded?.project === next.project && base.expanded.path === next.path
            ? null
            : next,
        highlight: null,
        precision: null,
        selection: next,
      }));
    },
    [recordHistory, revise],
  );

  /**
   * Open a workspace-relative path, which is how Go to Definition answers.
   *
   * A definition does not respect the panel's `{ project, path }` shape: it
   * can land in another repository of the same session, or in
   * `node_modules` of this one. Splitting it back apart needs the project
   * list, which is read here from `review.data`, and a path in none of them
   * cannot be opened at all — the file API resolves against a session's
   * projects, so a bare workspace path outside them would be refused.
   * Returning the error rather than showing it is what keeps this hook free
   * of its own notice-banner state; `ReviewPanel` already has one.
   *
   * Deliberately does not fold the hunk accordion open, unlike `selectFile`:
   * a definition target is usually an unchanged file, and expanding an
   * empty hunk list would read as the panel losing the row it had open.
   */
  const openWorkspacePath = useCallback(
    (path: string, line: number) => {
      const next = selectionForWorkspacePath(review.data?.projects ?? [], path);

      if (!next) {
        return {
          error: `${path} is not inside a project this session is linked to, so it cannot be opened here.`,
        };
      }

      recordHistory(next);
      revise((base) => ({
        highlight: null,
        precision: null,
        reveal: nextReveal(base, line),
        selection: next,
      }));
      return null;
    },
    [recordHistory, review.data?.projects, revise],
  );

  /**
   * Following is a saved preference, unpinned for this panel by an arrow.
   *
   * Two pieces of state rather than one because they answer different
   * questions. `followMode` is what the operator wants sessions to do and
   * outlives the panel; `unpinned` is "I have stepped away from the agent
   * for now", which must not rewrite that preference — an arrow press would
   * otherwise turn following off everywhere, permanently.
   */
  const settings = useUserSettings().data;
  const updateFollowMode = useUpdateFollowMode();
  const [unpinned, setUnpinned] = useState(false);
  const following = !unpinned && followModeEnabled(settings);

  /**
   * Open a stop from the scrubber.
   *
   * A bare tool stop — visible only under "All tools" — has no file to
   * open, so it unpins from following without touching the editor,
   * matching the scrubber's "no editor change" for a call that read or
   * wrote nothing.
   *
   * Does not fold the hunk accordion open, for the same reason a definition
   * target does not: most files the agent *read* have no hunks, and
   * expanding an empty list reads as the sidebar losing the row it had.
   */
  const openStep = useCallback(
    (stop: ScrubberStop) => {
      // Stepping by hand is a statement that the operator wants to be
      // somewhere specific, which is the opposite of following. It unpins
      // for this panel only: an arrow press is not a change of preference,
      // so the saved setting is left alone and the Follow button re-pins.
      setUnpinned(true);
      if (stop.kind === "tool") return;

      const { access } = stop;
      const { project } = access;
      // `buildSequence` never emits a "file" stop for an access outside
      // every linked project — that is what `unlinked` counts instead — so
      // this is unreachable in practice. The check (on a local, so it
      // narrows into the closure below) exists for the type, not the run.
      if (project === null) return;

      recordHistory({ path: access.path, project });
      revise((base) => {
        const line = revealLineFor(stop);
        return {
          highlight: {
            agent: agentLabelFor(access.agent),
            inferred: access.confidence === "inferred",
            kind: access.kind,
            ranges: access.ranges,
            tool: access.tool,
            via: access.via ?? null,
          },
          precision: null,
          reveal: line === null ? null : nextReveal(base, line),
          selection: { path: access.path, project },
        };
      });
    },
    [recordHistory, revise],
  );

  /**
   * Go to one review comment, wherever it is.
   *
   * Its own function rather than `selectFile` followed by `revealLine`,
   * because those are two revisions and only the second one's `reveal`
   * would survive: each `revise` starts from the current request, so the
   * pair races on which lands last. One revision changes file and line
   * together, which is also what makes stepping *within* one file work —
   * the selection does not change there, so only the reveal does.
   *
   * The hunk accordion is deliberately left alone, matching
   * `openWorkspacePath`: a commented file is often not a changed one, and
   * expanding an empty hunk list reads as the sidebar losing its open row.
   */
  const openComment = useCallback(
    (comment: ReviewComment) => {
      recordHistory({ path: comment.filePath, project: comment.projectPath });
      revise((base) => ({
        highlight: null,
        precision: null,
        reveal: nextReveal(base, comment.startLine),
        selection: { path: comment.filePath, project: comment.projectPath },
      }));
    },
    [recordHistory, revise],
  );

  const liveAccesses = useSessionLiveAccesses(sessionId).data;

  /**
   * The most recent live access the panel can actually open.
   *
   * Walked backwards rather than taking the last one outright: the agent
   * reads `node_modules` and deleted paths too, and following it onto one
   * of those would blank the editor mid-turn. Holding on the last openable
   * file is what "follow the agent" means in practice.
   */
  const followAccess = useMemo(() => {
    if (!following || !liveAccesses) return null;

    for (let index = liveAccesses.length - 1; index >= 0; index -= 1) {
      const access = liveAccesses[index]!;
      if (access.project !== null && !access.missing) return access;
    }
    return null;
  }, [following, liveAccesses]);

  /**
   * Following is a mode, not a copy of state.
   *
   * The displayed file is *derived* from the newest live access while it is
   * on, so nothing has to push a target into state as events arrive —
   * `react/set-state-in-effect` is an error here, and a synced copy would be
   * a second source of truth for which file is open.
   */
  const followRequest = useMemo((): PanelRequest | null => {
    if (!followAccess) return null;

    const first = followAccess.ranges[0];
    return {
      expanded: null,
      highlight: {
        agent: agentLabelFor(followAccess.agent),
        inferred: followAccess.confidence === "inferred",
        kind: followAccess.kind,
        ranges: followAccess.ranges,
        tool: followAccess.tool,
        via: followAccess.via ?? null,
      },
      // A follow request is not made "against" any target; it outranks both.
      overNonce: -1,
      precision: null,
      // The object's identity is what makes the editor scroll, so a memo
      // keyed on the access is enough — the number itself only has to be a
      // line.
      reveal: first ? { line: first.start, nonce: first.start } : null,
      selection: {
        path: followAccess.path,
        project: followAccess.project!,
      },
    };
  }, [followAccess]);

  /**
   * Turning follow off leaves the panel where the agent left it.
   *
   * Without this the derived follow request stops applying and the editor
   * jumps back to whatever was open before, which reads as the panel
   * losing the file the operator was just watching.
   */
  const changeFollowing = useCallback(
    (next: boolean) => {
      if (!next && followRequest) {
        revise(() => ({
          highlight: followRequest.highlight,
          precision: null,
          reveal: followRequest.reveal,
          selection: followRequest.selection,
        }));
      }

      // The button, unlike an arrow, is the operator stating a preference,
      // so it is saved. Clearing `unpinned` is what makes it re-pin after a
      // step.
      setUnpinned(false);
      updateFollowMode.mutate(next);
    },
    [followRequest, revise, updateFollowMode],
  );

  /**
   * Step to the previous/next file the operator explicitly opened.
   *
   * Unlike `selectFile`, these do not call `recordHistory` — stepping
   * through history is not itself a new entry, or the stack would only
   * ever grow forward and "back" would never reach the same file twice.
   * Silently does nothing at either end; the arrow buttons disable
   * themselves using `canGoBack`/`canGoForward` below, so a click here
   * should not happen, but this stays a no-op rather than throwing if one
   * ever does.
   */
  const goToHistory = useCallback(
    (next: FileHistoryState) => {
      const entry = currentFileHistoryEntry(next);
      if (!entry) return;
      setHistory(next);
      revise(() => ({
        expanded: entry,
        highlight: null,
        precision: null,
        selection: entry,
      }));
    },
    [revise],
  );
  const goBack = useCallback(
    () => goToHistory(stepHistoryBack(history)),
    [goToHistory, history],
  );
  const goForward = useCallback(
    () => goToHistory(stepHistoryForward(history)),
    [goToHistory, history],
  );

  // Following outranks the panel's own history — it is a mode the operator
  // switched on, and while it is on the panel's job is to be wherever the
  // agent is — but it does NOT outrank a fresh external target, which used
  // to open the panel and then lose the clicked file to the agent's latest
  // write. See `baseRequestFor` for why this is not `followRequest ?? …`
  // and why it yields for one target rather than unpinning.
  const baseRequest = baseRequestFor({
    chosen: chosenRequest,
    follow: followRequest,
    target,
  });
  const baseSelection = baseRequest.selection ?? defaultSelection(review.data);

  /**
   * The live hunks of whatever file is about to be shown, so an artifact
   * chip's anchor can be re-found against them. Reused, not a second
   * fetch: this is the same query key `ReviewEditorPane` reads for the
   * selected file's coloring, so react-query dedupes the two.
   */
  const activeHunks = useReviewHunks(
    sessionId,
    baseSelection?.project ?? null,
    baseSelection?.path ?? null,
  ).data?.full?.hunks;

  const request = useMemo(
    () => anchorRevealRequest(baseRequest, target, activeHunks),
    [activeHunks, baseRequest, target],
  );

  const { expanded, highlight, reveal } = request;
  const selection = request.selection ?? baseSelection;

  return {
    canGoBack: canGoBack(history),
    canGoForward: canGoForward(history),
    changeFollowing,
    expanded,
    following,
    goBack,
    goForward,
    highlight,
    openComment,
    openStep,
    openWorkspacePath,
    precision: request.precision,
    requestedSelection: request.selection,
    reveal,
    revealLine,
    selectFile,
    selectFileFromSidebar,
    selectedCommitSha,
    selection,
    setSelectedCommitSha,
  };
}
