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
}: {
  busy: boolean;
  message: string;
  onCommit: () => void;
  onMessageChange: (message: string) => void;
  project: ProjectReview | undefined;
  result: { ok: boolean; message: string } | null;
}) {
  const staged = stagedCount(project);
  const canCommit = staged > 0 && message.trim().length > 0 && !busy;

  return staged > 0 ? (
    <footer className="flex shrink-0 items-center gap-3 border-t px-3 py-2">
      <Input
        aria-label="Commit message"
        className="h-8 flex-1 font-mono text-xxs"
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

      <Button disabled={!canCommit} onClick={onCommit} size="sm">
        {busy ? <Spinner className="size-3.5" /> : null}
        Commit
      </Button>
    </footer>
  ) : null;
}
