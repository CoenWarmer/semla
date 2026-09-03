"use client";

/**
 * Commits the agent made while the turn ran.
 *
 * These are invisible without this list. Nothing stops the agent committing —
 * it has `bash` and the system prompt says nothing about git — so a review
 * surface that only read the working tree would report "nothing changed" for a
 * turn that wrote and committed a dozen files.
 *
 * Undoing them is offered rather than assumed. `git reset --mixed` is the only
 * destructive thing this panel can do, so the reason it might be refused is
 * shown before the button is pressed, and the confirmation says the count and
 * that the reflog still has them.
 */

import { UndoIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import type { ProjectReview } from "@/lib/review-types";
import type { UncommitPlan } from "@/hooks/use-review";

export function ReviewTurnCommits({
  busy,
  onUncommit,
  plan,
  project,
}: {
  busy: boolean;
  onUncommit: (target: string) => void;
  plan: UncommitPlan | undefined;
  project: ProjectReview;
}) {
  const [confirming, setConfirming] = useState(false);
  const commits = project.turnCommits;

  if (commits.length === 0) return null;

  return (
    <div className="flex flex-col gap-1 border-t pt-2">
      <div className="flex items-baseline gap-2 px-2">
        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Committed this turn
        </p>
        <span className="text-[10px] text-muted-foreground tabular-nums">
          {commits.length}
        </span>
      </div>

      {commits.map((commit) => (
        <div
          className="flex items-baseline gap-2 px-2 py-0.5 text-xs"
          key={commit.sha}
          title={`${commit.shortSha} · ${commit.author} · ${commit.fileCount} file${
            commit.fileCount === 1 ? "" : "s"
          }`}
        >
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
            {commit.shortSha}
          </span>
          <span className="min-w-0 flex-1 truncate">{commit.subject}</span>
        </div>
      ))}

      {plan && !plan.allowed ? (
        <p className="px-2 pt-1 text-[11px] text-muted-foreground">
          {plan.message}
        </p>
      ) : null}

      {plan?.allowed && plan.target ? (
        confirming ? (
          <div className="flex flex-col gap-1.5 px-2 pt-1">
            <p className="text-[11px] text-muted-foreground">
              Move {commits.length} commit
              {commits.length === 1 ? "" : "s"} back into the working tree, as
              unstaged changes?
              {plan.dirty
                ? " Uncommitted edits are already there and will be mixed in with them."
                : ""}{" "}
              Nothing is lost — <span className="font-mono">git reflog</span>{" "}
              keeps them.
            </p>
            <div className="flex gap-1.5">
              <Button
                className="h-6 px-2 text-[11px]"
                disabled={busy}
                onClick={() => {
                  setConfirming(false);
                  onUncommit(plan.target!);
                }}
                size="sm"
                variant="destructive"
              >
                Undo the commits
              </Button>
              <Button
                className="h-6 px-2 text-[11px]"
                onClick={() => setConfirming(false)}
                size="sm"
                variant="ghost"
              >
                Keep them
              </Button>
            </div>
          </div>
        ) : (
          <Button
            className="mx-2 mt-1 h-6 self-start px-2 text-[11px]"
            disabled={busy}
            onClick={() => setConfirming(true)}
            size="sm"
            variant="ghost"
          >
            <UndoIcon className="size-3" />
            Review them instead
          </Button>
        )
      ) : null}
    </div>
  );
}
