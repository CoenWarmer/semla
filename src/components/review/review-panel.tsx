"use client";

/**
 * The review surface: what the turn changed, in a repository, with the file
 * open beside it.
 *
 * A fixed overlay rather than a portal. The bottom bar had to portal because
 * the *bar* lives in the root layout while its data belongs to the session —
 * neither side could own both. Here there is no such split: the data is the
 * session's and fixed positioning already escapes the layout flow, so the
 * session tree renders it directly and keeps its subscriptions.
 *
 * The 20px sides and 40px top are the specified frame. The bottom is not: it
 * stops above the console bar rather than covering it, because that bar hosts
 * the agent timeline and the terminal, and hiding the controls that describe a
 * run while reviewing that run's output is the wrong trade.
 */

import { XIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { CONSOLE_BAR_HEIGHT, useBottomPanel } from "@/components/bottom-panel";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  useCommitReview,
  useReview,
  useSaveFile,
  useStageHunks,
  workspacePath,
} from "@/hooks/use-review";
import { isEmptyReview, totalChangedFiles } from "@/lib/review-types";
import type { SessionReview } from "@/lib/review-types";
import { cn } from "@/lib/utils";

import { ReviewChangedFiles, type FileSelection } from "./review-changed-files";
import { ReviewCommitBar } from "./review-commit-bar";
import { ReviewCommitNav } from "./review-commit-nav";
import { ReviewEditorPane } from "./review-editor-pane";
import { ReviewFileTree } from "./review-file-tree";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "../ui/resizable";

const SIDEBAR_WIDTH = 300;

/** The frame the panel is specified to sit in. */
const INSET = { left: 20, right: 20, top: 40 } as const;

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
  initialTarget,
  onClose,
  onExplain,
  sessionId,
}: {
  /**
   * Open on this file and line rather than the anchor project's first change.
   *
   * Consulted only for the panel's *initial* state — see the `key` this is
   * meant to be paired with on the caller's side (`ClientSessionComponent`),
   * which remounts the panel when a new target arrives so this is read again
   * rather than only once ever. Reading it in an effect instead would mean
   * setting state from that effect, which is the `react/set-state-in-effect`
   * error this repository treats as fatal.
   */
  initialTarget?: {
    project: string;
    path: string;
    line: number;
    /**
     * Whether `line` is the exact clicked position, or only the nearest
     * resolvable component's own declaration line. `"component"` is shown
     * as a notice rather than presented as if the panel scrolled to the
     * exact spot clicked — see `LocatedElement` in `element-locator.ts` for
     * why the element picker sometimes cannot do better than that.
     */
    precision?: "exact" | "component";
  } | null;
  onClose: () => void;
  /**
   * Ask the agent something. Routed up rather than handled here: the session
   * component owns the prompt mutation, and a second one in this panel would
   * be a second turn-runner in the same session.
   */
  onExplain: (prompt: string) => void;
  sessionId: string;
}) {
  const review = useReview(sessionId);
  const panel = useBottomPanel();

  const [chosen, setChosen] = useState<FileSelection | null>(() =>
    initialTarget
      ? { path: initialTarget.path, project: initialTarget.project }
      : null,
  );
  const [selectedCommitSha, setSelectedCommitSha] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<{ message: string; ok: boolean } | null>(
    null,
  );
  /**
   * A line for the editor to scroll to.
   *
   * Owned here rather than in the pane because two things ask for it: a hunk
   * row, and a content-search hit in the sidebar — and the second also changes
   * which file is open, so the request has to outlive the pane it lands in.
   */
  const [reveal, setReveal] = useState<{ line: number; nonce: number } | null>(
    () => (initialTarget ? { line: initialTarget.line, nonce: 1 } : null),
  );

  // The counter is what makes asking for the same line twice two requests
  // rather than one unchanged prop.
  const revealLine = useCallback(
    (line: number) =>
      setReveal((previous) => ({ line, nonce: (previous?.nonce ?? 0) + 1 })),
    [],
  );

  const stage = useStageHunks(sessionId);
  const commit = useCommitReview(sessionId);
  const save = useSaveFile(sessionId);

  const selection = chosen ?? defaultSelection(review.data);
  const projects = review.data?.projects ?? [];
  const activeProject =
    projects.find((project) => project.path === selection?.project) ??
    projects[0];

  const bottom = (panel?.open ? panel.height : 0) + CONSOLE_BAR_HEIGHT;
  const changed = review.data ? totalChangedFiles(review.data) : 0;
  const unsavedCount = Object.keys(drafts).length;
  const busy = stage.isPending || commit.isPending || save.isPending;

  // When the operator selects a commit, filter the changed-files list to only
  // the files that commit touched. The commit stores repo-relative paths;
  // changedFiles.path is also repo-relative, so the match is direct.
  const selectedCommit = activeProject?.turnCommits.find(
    (c) => c.sha === selectedCommitSha,
  ) ?? null;
  const visibleFiles = selectedCommit
    ? (activeProject?.changedFiles ?? []).filter((f) =>
        selectedCommit.files.includes(f.path),
      )
    : (activeProject?.changedFiles ?? []);

  // Escape closes, which is what every overlay in the app does. Registered on
  // the document because the editor swallows keys inside itself.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const onStage = useCallback(
    (hunks: number[], direction: "stage" | "unstage") => {
      if (!selection) return;
      stage.mutate(
        { direction, hunks, path: selection.path, project: selection.project },
        { onSuccess: (data) => setResult(data.ok ? null : data) },
      );
    },
    [selection, stage],
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
    <div
      aria-label="Review changes"
      className="semla-review-enter fixed z-40 flex flex-col overflow-hidden rounded-lg border bg-background shadow-2xl"
      role="dialog"
      style={{ bottom, left: INSET.left, right: INSET.right, top: INSET.top }}
    >
      <header className="relative flex shrink-0 items-center gap-3 border-b px-3 py-2">
        <h2 className="text-sm font-medium">Review</h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          {changed} changed {changed === 1 ? "file" : "files"}
        </span>
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
                  setChosen(
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

      {initialTarget?.precision === "component" && (
        <div className="flex shrink-0 items-center gap-2 border-b bg-muted/40 px-3 py-1">
          <span className="text-xs text-muted-foreground">
            Opened on the nearest component Semla could resolve — not
            necessarily the exact line clicked.
          </span>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <aside
          className="flex shrink-0 flex-col border-r"
          style={{ width: SIDEBAR_WIDTH }}
        >
          <ResizablePanelGroup orientation="vertical" className="h-full">
            <ResizablePanel
              defaultSize={40}
              minSize={15}
              className="overflow-y-auto py-2"
            >
              {review.isPending ? (
                <div className="flex justify-center py-4">
                  <Spinner />
                </div>
              ) : (
                <ReviewChangedFiles
                  onSelect={setChosen}
                  projects={
                    selectedCommit
                      ? projects.map((p) =>
                          p.path === activeProject?.path
                            ? { ...p, changedFiles: visibleFiles }
                            : p,
                        )
                      : projects
                  }
                  selected={selection}
                />
              )}
            </ResizablePanel>

            <ResizableHandle withHandle />

            {/* The whole project tree, keyed by project so switching repositories
                re-opens the tree on the new one's changes rather than keeping the
                old one's expansion. */}
            <ResizablePanel defaultSize={60} minSize={15} className="flex flex-col">
              {activeProject ? (
                <div className="flex h-full flex-col py-2">
                  <p className="shrink-0 px-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {activeProject.name}
                  </p>
                  <ReviewFileTree
                    key={activeProject.path}
                    onSelectPath={(path, line) => {
                      setChosen({ path, project: activeProject.path });
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

        <main className="min-w-0 flex-1">
          {selection ? (
            <ReviewEditorPane
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
              onReveal={revealLine}
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
      </div>

      <ReviewCommitBar
        busy={commit.isPending}
        message={message}
        onCommit={onCommit}
        onMessageChange={setMessage}
        project={activeProject}
        result={result}
        unsavedCount={unsavedCount}
      />
    </div>
  );
}
