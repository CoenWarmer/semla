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

import { useCallback, useEffect, useMemo, useState } from "react";

import { Spinner } from "@/components/ui/spinner";
import { useFileAccess } from "@/hooks/use-file-access";
import { toolCallStepsFromLive } from "@/lib/pi/file-access/access-live-merge";
import {
  useAllReviewComments,
  useCommitReview,
  useReview,
  useSaveFile,
  useStageHunks,
  workspacePath,
} from "@/hooks/use-review";
import { usePanelLayoutSaver, usePanelLayouts } from "@/hooks/use-panel-layout";
import type { HunkSelector } from "@/lib/pi/review/review-patch";
import { isEmptyReview } from "@/lib/review/review-types";
import type { ProjectReview } from "@/lib/review/review-types";
import type { ReviewComment } from "@/lib/review/review-comment-types";
import {
  useSessionLiveAccesses,
  useSessionLiveToolCalls,
} from "@/lib/session/session-live-state";
import { cn } from "@/lib/utils";

import { ReviewChangedFiles, type FileSelection } from "./review-changed-files";
import { ReviewCommitBar } from "./review-commit-bar";
import { ReviewCommitNav } from "./review-commit-nav";
import { ReviewEditorPane } from "./review-editor-pane";
import { ReviewFileTree } from "./review-file-tree";
import { cursorFilesFor, sameFile } from "./review-hunk-cursor";
import { useReviewHunkKeyboard } from "./review-hunk-keyboard";
import type { PanelTarget } from "./review-panel-request";
import { ReviewScrubber } from "./review-scrubber";
import { usePanelTarget } from "./use-panel-target";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "../ui/resizable";

/** A draft is keyed by repository and path: two projects can hold one name. */
const draftKey = (selection: FileSelection) =>
  `${selection.project}/${selection.path}`;

/**
 * A stable identity for "no projects yet", so a `useMemo` keyed on `projects`
 * does not recompute every render while `review.data` is still loading —
 * `review.data?.projects ?? []` would otherwise hand back a fresh array each
 * time, which is indistinguishable from a real change to any hook watching it.
 */
const NO_PROJECTS: readonly ProjectReview[] = [];

/** The same stable-identity trick for the comment sequence, see NO_PROJECTS. */
const NO_COMMENTS: readonly ReviewComment[] = [];

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
  const fileAccess = useFileAccess(sessionId, leafId ?? null);

  const {
    canGoBack,
    canGoForward,
    changeFollowing,
    expanded,
    following,
    goBack,
    goForward,
    highlight,
    openComment,
    openStep,
    openWorkspacePath: openWorkspacePathOrError,
    precision,
    requestedSelection,
    reveal,
    revealLine,
    selectFile,
    selectFileFromSidebar,
    selectedCommitSha,
    selection,
    setSelectedCommitSha,
  } = usePanelTarget(sessionId, target);

  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<{ message: string; ok: boolean } | null>(
    null,
  );

  /**
   * `usePanelTarget.openWorkspacePath` reports a refusal as a value rather
   * than a side effect — it has no notice-banner state of its own, and this
   * is the one place that does. Adapting it here keeps the hook free of a
   * concern that belongs to whichever surface renders the message.
   */
  const openWorkspacePath = useCallback(
    (path: string, line: number) => {
      const failure = openWorkspacePathOrError(path, line);
      if (failure) setResult({ message: failure.error, ok: false });
    },
    [openWorkspacePathOrError],
  );

  const stage = useStageHunks(sessionId);
  const commit = useCommitReview(sessionId);
  const save = useSaveFile(sessionId);

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

  const review = useReview(sessionId);

  /**
   * The sequence a comment card's arrows step through, and how to follow one.
   *
   * Memoised because its identity is a dependency of `CodeEditor`'s
   * view-zone rebuild effect — a fresh object each render would redraw every
   * comment zone on every render, which reflows the file (see
   * review-comment-widgets.tsx's docblock on why that is the one thing worth
   * avoiding here).
   */
  const allComments = useAllReviewComments(sessionId);
  const commentNavigation = useMemo(
    () => ({ goTo: openComment, ordered: allComments.data ?? NO_COMMENTS }),
    [allComments.data, openComment],
  );

  const liveAccesses = useSessionLiveAccesses(sessionId).data;
  const liveToolCalls = useSessionLiveToolCalls(sessionId).data;
  const calls = useMemo(
    () => [
      ...(fileAccess.data?.calls ?? []),
      ...toolCallStepsFromLive(liveToolCalls ?? [], liveAccesses ?? []),
    ],
    [fileAccess.data?.calls, liveAccesses, liveToolCalls],
  );
  const projects = review.data?.projects ?? NO_PROJECTS;
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
    (file: FileSelection, hunks: HunkSelector[], direction: "stage" | "unstage") => {
      stage.mutate(
        { direction, hunks, path: file.path, project: file.project },
        { onSuccess: (data) => setResult(data.ok ? null : data) },
      );
    },
    [stage],
  );

  const onStage = useCallback(
    (hunks: HunkSelector[], direction: "stage" | "unstage") => {
      if (!selection) return;
      onStageFile(selection, hunks, direction);
    },
    [onStageFile, selection],
  );

  /**
   * Stage or unstage a whole file, for the drag-to-stage gesture.
   *
   * Separate from `onStageFile` rather than that function called with an
   * empty `hunks` array: an empty selection means "apply this" only for a
   * hunkless file (see `buildPatch`), so it silently does nothing for the
   * ordinary case of a file with hunks — which is exactly the file a drag is
   * most likely to be dropped on. `whole: true` skips hunk selection in the
   * route entirely instead.
   */
  const onStageWholeFile = useCallback(
    (file: FileSelection, direction: "stage" | "unstage") => {
      stage.mutate(
        {
          direction,
          hunks: [],
          path: file.path,
          project: file.project,
          whole: true,
        },
        { onSuccess: (data) => setResult(data.ok ? null : data) },
      );
    },
    [stage],
  );

  /**
   * Every file the keyboard cursor walks, across every project — the same
   * list `ReviewChangedFiles` used to compute for itself before the cursor
   * moved up here. See `cursorFilesFor` for the walk order and why a
   * partially staged file contributes only one entry.
   */
  const cursorFiles = useMemo(
    () => cursorFilesFor(projects, selectedCommitSha),
    [projects, selectedCommitSha],
  );

  /**
   * The keyboard cursor itself, lifted out of `ReviewChangedFiles` so the
   * editor pane can read `position` too — it is what decides which hunk
   * Monaco highlights as "current", the same hunk the sidebar rings.
   */
  const { onFilePicked, position } = useReviewHunkKeyboard({
    enabled: selectedCommitSha === null,
    expanded,
    files: cursorFiles,
    onNavigate: selectFile,
    onReveal: revealLine,
    onStage: onStageFile,
    selected: selection,
    sessionId,
  });

  /**
   * The cursor's hunk, only while it is in the file the editor has open —
   * `position.file` can be a different file the sidebar is highlighting
   * (mid-`d`/`w` cross-file move) that this open editor is not showing.
   */
  const currentHunkSlot =
    position?.slot && selection && sameFile(position.file, selection)
      ? position.slot
      : null;

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
        {precision === "component" && (
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
                <header className="relative flex shrink-0 items-center center w-full gap-3 border-b px-3 py-2">
                  {/* A session can work in several repositories, and a commit is always
            against exactly one of them — so which is a choice, not a guess. */}
                  {activeProject && activeProject.turnCommits.length > 0 && (
                    <ReviewCommitNav
                      commits={activeProject.turnCommits}
                      selectedSha={selectedCommitSha}
                      onSelect={setSelectedCommitSha}
                    />
                  )}
                </header>
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
                  >
                    {review.isPending ? (
                      <div className="flex justify-center py-4">
                        <Spinner />
                      </div>
                    ) : (
                      <div className="flex flex-col h-full w-full relative">
                        <div className="flex grow w-full overflow-y-auto">
                          <ReviewChangedFiles
                            busy={busy}
                            expanded={expanded}
                            onClearCommit={() => setSelectedCommitSha(null)}
                            // The panel owns the cursor now (see
                            // `useReviewHunkKeyboard` above) — a click only
                            // reports where it landed, so a later keypress
                            // continues from there.
                            onFilePicked={onFilePicked}
                            onReveal={revealLine}
                            onSelect={selectFileFromSidebar}
                            onStage={onStageFile}
                            onStageWhole={onStageWholeFile}
                            position={position}
                            projects={projects}
                            selected={selection}
                            selectedCommitSha={selectedCommitSha}
                            sessionId={sessionId}
                          />
                        </div>
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
                    canGoBack={canGoBack}
                    canGoForward={canGoForward}
                    onGoBack={goBack}
                    onGoForward={goForward}
                    access={
                      // Only while the highlight describes the file on screen: the
                      // operator can move off a scrubber stop with the sidebar, and
                      // the marks must not follow them onto another file.
                      highlight &&
                      requestedSelection?.path === selection.path &&
                      requestedSelection.project === selection.project
                        ? highlight
                        : null
                    }
                    busy={busy}
                    currentHunk={currentHunkSlot}
                    draft={drafts[draftKey(selection)] ?? null}
                    onExplain={onExplain}
                    onClose={onClose}
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
                    commentNavigation={commentNavigation}
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
