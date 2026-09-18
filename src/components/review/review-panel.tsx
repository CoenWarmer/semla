"use client";

/**
 * The review surface: what the turn changed, in a repository, with the file
 * open beside it.
 *
 * Rendered inline, as one panel of the session's own resizable group
 * (`ClientSessionComponent`) alongside the conversation — not a floating
 * overlay. The data is the session's, so the session tree renders it
 * directly and keeps its subscriptions; there is no portal boundary to cross.
 */

import { XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useFileAccess } from "@/hooks/use-file-access";
import { toolCallStepsFromLive } from "@/lib/pi/file-access/access-live-merge";
import {
  revealLineFor,
  type ScrubberStop,
} from "@/lib/pi/file-access/access-sequence";
import {
  useCommitReview,
  useReview,
  useReviewHunks,
  useSaveFile,
  useStageHunks,
  workspacePath,
} from "@/hooks/use-review";
import {
  followModeEnabled,
  useUpdateFollowMode,
  useUserSettings,
} from "@/hooks/use-user-settings";
import { usePanelLayoutSaver, usePanelLayouts } from "@/hooks/use-panel-layout";
import { isEmptyReview } from "@/lib/review/review-types";
import type { SessionReview } from "@/lib/review/review-types";
import {
  useSessionLiveAccesses,
  useSessionLiveToolCalls,
} from "@/lib/session/session-live-state";
import { cn } from "@/lib/utils";

import { agentLabelFor } from "./review-access-labels";
import { anchorRevealRequest } from "./review-anchor-reveal";
import {
  activeCommitSha,
  BLANK_COMMIT_SELECTION,
} from "./review-artifact-commit";
import { ReviewChangedFiles, type FileSelection } from "./review-changed-files";
import { ReviewCommitBar } from "./review-commit-bar";
import { ReviewCommitNav } from "./review-commit-nav";
import { ReviewEditorPane } from "./review-editor-pane";
import { selectionForWorkspacePath } from "./review-definition-target";
import { ReviewFileTree } from "./review-file-tree";
import {
  activeRequest,
  baseRequestFor,
  nextReveal,
  type PanelRequest,
  type PanelTarget,
} from "./review-panel-request";
import { ReviewScrubber } from "./review-scrubber";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "../ui/resizable";

/** A draft is keyed by repository and path: two projects can hold one name. */
const draftKey = (selection: FileSelection) =>
  `${selection.project}/${selection.path}`;

/**
 * The first thing worth showing: the anchor project's first changed file.
 *
 * Derived during render rather than pushed into state by an effect. Choosing a
 * default in an effect is the `react/set-state-in-effect` error this
 * repository treats as fatal, and it also flashes an empty pane for a frame.
 */
function defaultSelection(
  review: SessionReview | undefined,
): FileSelection | null {
  for (const project of review?.projects ?? []) {
    const first = project.changedFiles[0];
    if (first) return { path: first.path, project: project.path };
  }
  return null;
}

export function ReviewPanel({
  leafId,
  onClose,
  onExplain,
  sessionId,
  target,
}: {
  /** The branch being viewed, so the scrubber describes the same conversation. */
  leafId?: string | null;
  onClose: () => void;
  /**
   * Ask the agent something. Routed up rather than handled here: the session
   * component owns the prompt mutation, and a second one in this panel would
   * be a second turn-runner in the same session.
   */
  onExplain: (prompt: string) => void;
  sessionId: string;
  /**
   * Open on this file and line rather than the anchor project's first change.
   *
   * Read on every render, not just on mount: the panel is a controlled
   * component now, because the scrubber changes the target several times a
   * second and the remount this used to require would throw away drafts, the
   * hunk accordion and the commit message each time. The precedence between
   * this and the panel's own navigation lives in review-panel-request.ts.
   */
  target?: PanelTarget | null;
}) {
  const review = useReview(sessionId);

  /**
   * Where the panel has navigated itself — a sidebar click, a scrubber step.
   *
   * Stale by construction once a newer `target` arrives, which is what removes
   * the need to sync the prop into state from an effect.
   */
  const [ownRequest, setOwnRequest] = useState<PanelRequest | null>(null);
  const chosenRequest = useMemo(
    () => activeRequest(ownRequest, target),
    [ownRequest, target],
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

  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<{ message: string; ok: boolean } | null>(
    null,
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

  const stage = useStageHunks(sessionId);
  const commit = useCommitReview(sessionId);
  const save = useSaveFile(sessionId);

  // Selecting a file opens it in the editor and folds its hunks open in the
  // sidebar — one click, not two. A null selection (the project-tab switch
  // when a project has no changed files) closes the accordion too, since
  // there is nothing left to have open.
  //
  // The agent's read highlight is dropped: it described the file the scrubber
  // was on, and leaving it behind would mark lines of a file the agent may
  // never have opened.
  const selectFile = useCallback(
    (next: FileSelection | null) =>
      revise(() => ({
        expanded: next,
        highlight: null,
        precision: null,
        selection: next,
      })),
    [revise],
  );

  /**
   * Open a workspace-relative path, which is how Go to Definition answers.
   *
   * A definition does not respect the panel's `{ project, path }` shape: it can
   * land in another repository of the same session, or in `node_modules` of
   * this one. Splitting it back apart needs the project list, which lives
   * here, and a path in none of them cannot be opened at all — the file API
   * resolves against a session's projects, so a bare workspace path outside
   * them would be refused. Saying so is better than a click that appears to do
   * nothing.
   *
   * Deliberately does not fold the hunk accordion open, unlike `selectFile`: a
   * definition target is usually an unchanged file, and expanding an empty
   * hunk list would read as the panel losing the row it had open.
   */
  const openWorkspacePath = useCallback(
    (workspacePath: string, line: number) => {
      const next = selectionForWorkspacePath(
        review.data?.projects ?? [],
        workspacePath,
      );

      if (!next) {
        setResult({
          message: `${workspacePath} is not inside a project this session is linked to, so it cannot be opened here.`,
          ok: false,
        });
        return;
      }

      revise((base) => ({
        highlight: null,
        precision: null,
        reveal: nextReveal(base, line),
        selection: next,
      }));
    },
    [review.data?.projects, revise],
  );

  /**
   * Following is a saved preference, unpinned for this panel by an arrow.
   *
   * Two pieces of state rather than one because they answer different
   * questions. `followMode` is what the operator wants sessions to do and
   * outlives the panel; `unpinned` is "I have stepped away from the agent for
   * now", which must not rewrite that preference — an arrow press would
   * otherwise turn following off everywhere, permanently.
   */
  const settings = useUserSettings().data;
  const updateFollowMode = useUpdateFollowMode();
  const [unpinned, setUnpinned] = useState(false);
  const following = !unpinned && followModeEnabled(settings);

  // The two dragged splits inside the review surface — sidebar/editor, and
  // changed-files/file-tree within the sidebar — restored on reload.
  const panelLayoutsQuery = usePanelLayouts();
  const panelLayouts = panelLayoutsQuery.data;
  const sidebarSplitLayout = panelLayouts?.["review-sidebar-split"] as
    | Record<string, number>
    | undefined;
  const saveSidebarSplit = usePanelLayoutSaver("review-sidebar-split");
  const sidebarInnerSplitLayout = panelLayouts?.[
    "review-sidebar-inner-split"
  ] as Record<string, number> | undefined;
  const saveSidebarInnerSplit = usePanelLayoutSaver(
    "review-sidebar-inner-split",
  );
  // react-resizable-panels reads `defaultLayout` once, in the effect that
  // runs on mount, and never re-reads it once the panel-layout query
  // resolves later — so a group that mounts before the fetch settles keeps
  // an undefined default for the rest of the page's life even after the
  // real saved split arrives. Remounting once the query settles gives it
  // the real value the one time it actually reads the prop.
  const layoutRemountKey = panelLayoutsQuery.isPending ? "pending" : "ready";

  /**
   * Open a stop from the scrubber.
   *
   * A bare tool stop — visible only under "All tools" — has no file to open,
   * so it unpins from following without touching the editor, matching the
   * scrubber's "no editor change" for a call that read or wrote nothing.
   *
   * Does not fold the hunk accordion open, for the same reason a definition
   * target does not: most files the agent *read* have no hunks, and expanding
   * an empty list reads as the sidebar losing the row it had.
   */
  const openStep = useCallback(
    (stop: ScrubberStop) => {
      // Stepping by hand is a statement that the operator wants to be
      // somewhere specific, which is the opposite of following. It unpins for
      // this panel only: an arrow press is not a change of preference, so the
      // saved setting is left alone and the Follow button re-pins.
      setUnpinned(true);
      if (stop.kind === "tool") return;

      const { access } = stop;
      const { project } = access;
      // `buildSequence` never emits a "file" stop for an access outside every
      // linked project — that is what `unlinked` counts instead — so this is
      // unreachable in practice. The check (on a local, so it narrows into the
      // closure below) exists for the type, not the run.
      if (project === null) return;

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
    [revise],
  );

  const fileAccess = useFileAccess(sessionId, leafId ?? null);
  const liveAccesses = useSessionLiveAccesses(sessionId).data;

  /**
   * The most recent live access the panel can actually open.
   *
   * Walked backwards rather than taking the last one outright: the agent reads
   * `node_modules` and deleted paths too, and following it onto one of those
   * would blank the editor mid-turn. Holding on the last openable file is what
   * "follow the agent" means in practice.
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
   * The displayed file is *derived* from the newest live access while it is on,
   * so nothing has to push a target into state as events arrive —
   * `react/set-state-in-effect` is an error here, and a synced copy would be a
   * second source of truth for which file is open.
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
      // The object's identity is what makes the editor scroll, so a memo keyed
      // on the access is enough — the number itself only has to be a line.
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
   * Without this the derived follow request stops applying and the editor jumps
   * back to whatever was open before, which reads as the panel losing the file
   * the operator was just watching.
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

      // The button, unlike an arrow, is the operator stating a preference, so
      // it is saved. Clearing `unpinned` is what makes it re-pin after a step.
      setUnpinned(false);
      updateFollowMode.mutate(next);
    },
    [followRequest, revise, updateFollowMode],
  );

  // Following outranks the panel's own history — it is a mode the operator
  // switched on, and while it is on the panel's job is to be wherever the
  // agent is — but it does NOT outrank a fresh external target, which used to
  // open the panel and then lose the clicked file to the agent's latest write.
  // See `baseRequestFor` for why this is not `followRequest ?? …` and why it
  // yields for one target rather than unpinning.
  const baseRequest = baseRequestFor({
    chosen: chosenRequest,
    follow: followRequest,
    target,
  });
  const baseSelection = baseRequest.selection ?? defaultSelection(review.data);

  /**
   * The live hunks of whatever file is about to be shown, so an artifact
   * chip's anchor can be re-found against them. Reused, not a second fetch:
   * this is the same query key `ReviewEditorPane` reads for the selected
   * file's coloring, so react-query dedupes the two.
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

  const liveToolCalls = useSessionLiveToolCalls(sessionId).data;
  const calls = useMemo(
    () => [
      ...(fileAccess.data?.calls ?? []),
      ...toolCallStepsFromLive(liveToolCalls ?? [], liveAccesses ?? []),
    ],
    [fileAccess.data?.calls, liveAccesses, liveToolCalls],
  );
  const projects = review.data?.projects ?? [];
  const activeProject =
    projects.find((project) => project.path === selection?.project) ??
    projects[0];

  const busy = stage.isPending || commit.isPending || save.isPending;

  // Which files the changed-files list shows is decided in that component,
  // from `selectedCommitSha`, by the pure rule in review-commit-scope.ts.
  //
  // It used to be decided here, by intersecting the selected commit's paths
  // with `git status` output — so a file the agent committed and did not touch
  // again was clean, absent from `changedFiles`, and therefore vanished from
  // the very commit that changed it. The panel keeps the selection; it no
  // longer reshapes the projects it passes down.

  // Escape closes, which is what every overlay in the app does. Registered on
  // the document because the editor swallows keys inside itself.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  /**
   * Stage or unstage hunks of a specific file.
   *
   * Takes the file explicitly rather than reading it off the panel's
   * `selection` state: `ReviewStagedFiles` renders hunk lists for every
   * staged file at once, none of which is necessarily the one currently
   * selected in the editor, and closing over `selection` here staged hunks
   * against the wrong file — or against none, silently, whenever nothing
   * was selected.
   */
  const onStageFile = useCallback(
    (file: FileSelection, hunks: number[], direction: "stage" | "unstage") => {
      stage.mutate(
        { direction, hunks, path: file.path, project: file.project },
        { onSuccess: (data) => setResult(data.ok ? null : data) },
      );
    },
    [stage],
  );

  const onStage = useCallback(
    (hunks: number[], direction: "stage" | "unstage") => {
      if (!selection) return;
      onStageFile(selection, hunks, direction);
    },
    [onStageFile, selection],
  );

  const onSave = useCallback(
    (content: string, sha: string | undefined) => {
      if (!selection) return;
      const key = draftKey(selection);

      save.mutate(
        {
          content,
          path: workspacePath(selection.project, selection.path),
          sha,
        },
        {
          onError: (error) => setResult({ message: error.message, ok: false }),
          onSuccess: () => {
            setResult(null);
            setDrafts((previous) => {
              const next = { ...previous };
              delete next[key];
              return next;
            });
          },
        },
      );
    },
    [save, selection],
  );

  const onCommit = useCallback(() => {
    if (!activeProject) return;
    commit.mutate(
      { message, project: activeProject.path },
      {
        onSuccess: (data) => {
          setResult(
            data.ok
              ? {
                  message: `Committed ${data.sha?.slice(0, 7) ?? ""}`,
                  ok: true,
                }
              : data,
          );
          if (data.ok) setMessage("");
        },
      },
    );
  }, [activeProject, commit, message]);

  return (
    <>
      <header className="relative flex shrink-0 items-center gap-3 border-b px-3 py-2">
        <h2 className="text-sm font-medium">Files</h2>
        {/* A session can work in several repositories, and a commit is always
            against exactly one of them — so which is a choice, not a guess. */}
        {projects.length > 1 ? (
          <div className="flex items-center gap-1">
            {projects.map((project) => (
              <button
                className={cn(
                  "rounded px-2 py-0.5 text-xs transition-colors",
                  project.path === activeProject?.path
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
                key={project.path}
                onClick={() =>
                  selectFile(
                    project.changedFiles[0]
                      ? {
                          path: project.changedFiles[0].path,
                          project: project.path,
                        }
                      : null,
                  )
                }
                type="button"
              >
                {project.name}
              </button>
            ))}
          </div>
        ) : activeProject ? (
          <span className="text-xs text-muted-foreground">
            {activeProject.name}
          </span>
        ) : null}

        {activeProject && activeProject.turnCommits.length > 0 && (
          <div className="absolute left-1/2 -translate-x-1/2">
            <ReviewCommitNav
              commits={activeProject.turnCommits}
              selectedSha={selectedCommitSha}
              onSelect={setSelectedCommitSha}
            />
          </div>
        )}

        {/* Phase 1 of docs/plans/session-isolation.md: the changed-files list
            above is read straight off the shared working tree, so it can
            include a file another session wrote. This is why, not a guess. */}
        {activeProject && activeProject.otherActiveSessions > 0 && (
          <span
            className="rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-600 dark:text-amber-400"
            title={`${activeProject.otherActiveSessions} other session${
              activeProject.otherActiveSessions === 1 ? "" : "s"
            } are active in ${activeProject.name} right now — changed files here may include their edits, and a commit here may include their staged changes.`}
          >
            shared with {activeProject.otherActiveSessions} other session
            {activeProject.otherActiveSessions === 1 ? "" : "s"}
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          <Button
            aria-label="Close review"
            onClick={onClose}
            size="icon"
            variant="ghost"
          >
            <XIcon className="size-4" />
          </Button>
        </div>
      </header>

      {/* The glow says the panel is being driven by the agent, which is worth
          saying because the editor moving on its own is otherwise
          indistinguishable from the panel losing the operator's place. */}
      {/* `min-h-0` is load-bearing, not tidying. Without it this column keeps
          `min-height: auto`, so its height is pinned to the min-content height
          of the editor and scrubber inside it and it cannot shrink when the
          panel does — opening the bottom bar's console then left the panel
          1100px tall with 1300px of content, the surplus clipped by the
          `overflow-hidden` above and the scrubber hidden behind the console. */}
      <div
        className={cn(
          "flex min-h-0 grow flex-col rounded rounded-b-[2.05rem]",
          following && "semla-following",
        )}
      >
        {request.precision === "component" && (
          <div className="flex shrink-0 items-center gap-2 border-b bg-muted/40 px-3 py-1">
            <span className="text-xs text-muted-foreground">
              Opened on the nearest component Semla could resolve — not
              necessarily the exact line clicked.
            </span>
          </div>
        )}

        <div className="flex min-h-0 flex-1">
          <ResizablePanelGroup
            orientation="horizontal"
            className="h-full"
            defaultLayout={sidebarSplitLayout}
            key={layoutRemountKey}
            onLayoutChanged={(layout, meta) => {
              if (meta.isUserInteraction) saveSidebarSplit(layout);
            }}
          >
            <ResizablePanel
              className="overflow-y-auto py-2"
              id="sidebar"
              // Fixed in pixels rather than the default `preserve-relative-
              // size`, so dragging the outer conversation/review split does
              // not rescale the file-tree/editor split inside it — the
              // sidebar holds its width and the editor panel absorbs the
              // change instead, matching what a resize of the outer group
              // should mean for a sidebar with independent content.
              groupResizeBehavior="preserve-pixel-size"
            >
              <aside className="flex shrink-0 flex-col border-r h-full">
                <ResizablePanelGroup
                  orientation="vertical"
                  className="h-full"
                  defaultLayout={sidebarInnerSplitLayout}
                  key={layoutRemountKey}
                  onLayoutChanged={(layout, meta) => {
                    if (meta.isUserInteraction) saveSidebarInnerSplit(layout);
                  }}
                >
                  <ResizablePanel
                    defaultSize={15}
                    id="changed-files"
                    minSize={15}
                    className="overflow-y-auto py-2"
                  >
                    {review.isPending ? (
                      <div className="flex justify-center py-4">
                        <Spinner />
                      </div>
                    ) : (
                      <div className="flex flex-col h-full w-full relative">
                        <ReviewChangedFiles
                          busy={busy}
                          expanded={expanded}
                          onClearCommit={() => setSelectedCommitSha(null)}
                          onReveal={revealLine}
                          onSelect={(next) => {
                            // Toggle: clicking the already-expanded file's row
                            // closes it again rather than being a no-op, since it
                            // is already the open editor selection.
                            revise((base) => ({
                              expanded:
                                base.expanded?.project === next.project &&
                                base.expanded.path === next.path
                                  ? null
                                  : next,
                              highlight: null,
                              precision: null,
                              selection: next,
                            }));
                          }}
                          onStage={onStageFile}
                          projects={projects}
                          selected={selection}
                          selectedCommitSha={selectedCommitSha}
                          sessionId={sessionId}
                        />
                        <ReviewCommitBar
                          busy={commit.isPending}
                          message={message}
                          onCommit={onCommit}
                          onMessageChange={setMessage}
                          project={activeProject}
                          result={result}
                        />
                      </div>
                    )}
                  </ResizablePanel>

                  <ResizableHandle withHandle />

                  {/* The whole project tree, keyed by project so switching repositories
                re-opens the tree on the new one's changes rather than keeping the
                old one's expansion. */}
                  <ResizablePanel
                    defaultSize={60}
                    id="file-tree"
                    minSize={15}
                    className="flex flex-col"
                  >
                    {activeProject ? (
                      <div className="flex flex-col py-2 max-h-[stretch]">
                        <ReviewFileTree
                          key={activeProject.path}
                          onSelectPath={(path, line) => {
                            selectFile({ path, project: activeProject.path });
                            if (line) revealLine(line);
                          }}
                          project={activeProject}
                          projects={projects}
                          selectedPath={
                            selection?.project === activeProject.path
                              ? selection.path
                              : null
                          }
                          sessionId={sessionId}
                        />
                      </div>
                    ) : null}
                  </ResizablePanel>
                </ResizablePanelGroup>
              </aside>
            </ResizablePanel>
            <ResizablePanel className="overflow-y-auto" id="editor">
              <main className="min-w-0 flex-1 h-full">
                {selection ? (
                  <ReviewEditorPane
                    access={
                      // Only while the highlight describes the file on screen: the
                      // operator can move off a scrubber stop with the sidebar, and
                      // the marks must not follow them onto another file.
                      highlight &&
                      request.selection?.path === selection.path &&
                      request.selection.project === selection.project
                        ? highlight
                        : null
                    }
                    busy={busy}
                    draft={drafts[draftKey(selection)] ?? null}
                    onExplain={onExplain}
                    onDraftChange={(content, dirty) =>
                      setDrafts((previous) => {
                        const key = draftKey(selection);
                        if (!dirty) {
                          if (!(key in previous)) return previous;
                          const next = { ...previous };
                          delete next[key];
                          return next;
                        }
                        return { ...previous, [key]: content };
                      })
                    }
                    onOpenWorkspacePath={openWorkspacePath}
                    onSave={onSave}
                    onStage={onStage}
                    reveal={reveal}
                    selection={selection}
                    sessionId={sessionId}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                    {review.data && isEmptyReview(review.data)
                      ? "Nothing to review."
                      : "Select a file."}
                  </div>
                )}
              </main>
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
        {calls.length > 0 ? (
          <ReviewScrubber
            agents={fileAccess.data?.agents ?? []}
            calls={calls}
            following={following}
            onFollowingChange={changeFollowing}
            onStep={openStep}
            turns={fileAccess.data?.turns ?? []}
          />
        ) : null}
      </div>
    </>
  );
}
