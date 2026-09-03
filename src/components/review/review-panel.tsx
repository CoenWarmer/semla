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
  useUncommit,
  useUncommitPlan,
  workspacePath,
} from "@/hooks/use-review";
import { isEmptyReview, totalChangedFiles } from "@/lib/review-types";
import type { SessionReview } from "@/lib/review-types";
import { cn } from "@/lib/utils";

import {
  ReviewChangedFiles,
  type FileSelection,
} from "./review-changed-files";
import { ReviewCommitBar } from "./review-commit-bar";
import { ReviewEditorPane } from "./review-editor-pane";
import { ReviewTurnCommits } from "./review-turn-commits";

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
  onClose,
  onExplain,
  sessionId,
}: {
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

  const [chosen, setChosen] = useState<FileSelection | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<{ message: string; ok: boolean } | null>(
    null,
  );

  const stage = useStageHunks(sessionId);
  const commit = useCommitReview(sessionId);
  const save = useSaveFile(sessionId);
  const uncommit = useUncommit(sessionId);

  const selection = chosen ?? defaultSelection(review.data);
  const projects = review.data?.projects ?? [];
  const activeProject =
    projects.find((project) => project.path === selection?.project) ??
    projects[0];

  // Only asked for when there is something to ask about: the plan costs an
  // ancestry check, an upstream lookup and two rev-lists.
  const uncommitPlan = useUncommitPlan(
    sessionId,
    activeProject?.path ?? null,
    (activeProject?.turnCommits.length ?? 0) > 0,
  );

  const bottom = (panel?.open ? panel.height : 0) + CONSOLE_BAR_HEIGHT;
  const changed = review.data ? totalChangedFiles(review.data) : 0;
  const unsavedCount = Object.keys(drafts).length;
  const busy =
    stage.isPending || commit.isPending || save.isPending || uncommit.isPending;

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
        { content, path: workspacePath(selection.project, selection.path), sha },
        {
          onError: (error) =>
            setResult({ message: error.message, ok: false }),
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
              ? { message: `Committed ${data.sha?.slice(0, 7) ?? ""}`, ok: true }
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
      className="fixed z-40 flex flex-col overflow-hidden rounded-lg border bg-background shadow-2xl"
      role="dialog"
      style={{ bottom, left: INSET.left, right: INSET.right, top: INSET.top }}
    >
      <header className="flex shrink-0 items-center gap-3 border-b px-3 py-2">
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

        <div className="ml-auto flex items-center gap-2">
          {selection ? (
            <span className="max-w-md truncate font-mono text-xs text-muted-foreground">
              {selection.path}
            </span>
          ) : null}

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

      <div className="flex min-h-0 flex-1">
        <aside
          className="flex shrink-0 flex-col gap-2 overflow-y-auto border-r py-2"
          style={{ width: SIDEBAR_WIDTH }}
        >
          {review.isPending ? (
            <div className="flex justify-center py-4">
              <Spinner />
            </div>
          ) : (
            <>
              <ReviewChangedFiles
                onSelect={setChosen}
                projects={projects}
                selected={selection}
              />

              {activeProject ? (
                <ReviewTurnCommits
                  busy={busy}
                  onUncommit={(target) =>
                    uncommit.mutate(
                      { project: activeProject.path, target },
                      { onSuccess: (data) => setResult(data) },
                    )
                  }
                  plan={uncommitPlan.data}
                  project={activeProject}
                />
              ) : null}
            </>
          )}
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
              onSave={onSave}
              onStage={onStage}
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
