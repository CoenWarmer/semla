"use client";

/**
 * The footer: what is staged, a message, and the commit.
 *
 * The commit button is the whole point of the surface, so it is the only thing
 * here that is not subtle. It stays disabled with a stated reason rather than
 * failing on press — "nothing is staged" is more useful before the click than
 * after it.
 */

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import type { ProjectReview } from "@/lib/review-types";

/** Files the index would carry into a commit right now. */
export const stagedCount = (project: ProjectReview | undefined): number =>
  (project?.changedFiles ?? []).filter((file) => file.staged).length;

export function ReviewCommitBar({
  busy,
  message,
  onCommit,
  onMessageChange,
  project,
  result,
  unsavedCount,
}: {
  busy: boolean;
  message: string;
  onCommit: () => void;
  onMessageChange: (message: string) => void;
  project: ProjectReview | undefined;
  result: { ok: boolean; message: string } | null;
  unsavedCount: number;
}) {
  const staged = stagedCount(project);
  const canCommit = staged > 0 && message.trim().length > 0 && !busy;

  /**
   * Why the button is off, in the order the operator can act on. Unsaved
   * edits come first: they are the one condition where committing would
   * succeed and still not include what is on screen.
   */
  const blocker =
    unsavedCount > 0
      ? `${unsavedCount} unsaved ${unsavedCount === 1 ? "edit" : "edits"} — save before committing`
      : staged === 0
        ? "Stage some hunks to commit"
        : message.trim().length === 0
          ? "A commit needs a message"
          : null;

  return (
    <footer className="flex shrink-0 items-center gap-3 border-t px-3 py-2">
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {staged} staged
      </span>

      <Input
        aria-label="Commit message"
        className="h-8 flex-1 font-mono text-xs"
        onChange={(event) => onMessageChange(event.target.value)}
        onKeyDown={(event) => {
          // Enter commits, which is what a single-line message field in a
          // review tool is for.
          if (event.key === "Enter" && canCommit) onCommit();
        }}
        placeholder="[Component]: what changed and why"
        value={message}
      />

      {result ? (
        <span
          className={
            result.ok
              ? "max-w-xs truncate text-xs text-emerald-500"
              : "max-w-xs truncate text-xs text-destructive"
          }
          title={result.message}
        >
          {result.message}
        </span>
      ) : null}

      {blocker ? (
        <span className="shrink-0 text-xs text-muted-foreground">{blocker}</span>
      ) : null}

      <Button disabled={!canCommit} onClick={onCommit} size="sm">
        {busy ? <Spinner className="size-3.5" /> : null}
        Commit
      </Button>
    </footer>
  );
}
