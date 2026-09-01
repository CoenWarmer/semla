"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, GitBranch, GitMerge } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { gitStatusQueryKey, useGitStatus, type GitTarget } from "@/hooks/use-git-status";
import { branchNameFromBase, describeGitStatus } from "@/lib/git-status-display";
import { cn } from "@/lib/utils";

type GitAction = "merge" | "checkout";

interface ActionOutcome {
  ok: boolean;
  message: string;
}

/** The project a target names, for `showProjectName`. */
const projectNameOf = (target: GitTarget | undefined): string | null => {
  const path = target && "path" in target ? target.path : null;
  if (!path) return null;
  // Split by hand rather than importing node:path: this is a client component.
  // Works for both shapes a target carries — the workspace target's absolute
  // path, and the session target's workspace-relative one.
  return path.split("/").filter(Boolean).pop() ?? null;
};

/**
 * Branch and divergence for a project, with the two moves you usually want
 * next: take the canonical branch's commits, or go stand on it.
 *
 * Three surfaces share this. The app header names each of the session's
 * projects and shows what its branch is doing; a sidebar row names them and
 * stops there; a project card shows the branch, since the card title is already
 * the name.
 *
 * Renders nothing at all when there is nothing to say — no project, or a
 * directory that is not a repository. An empty slot reads better than a
 * placeholder next to the model picker. A *named* badge is held to a weaker
 * test: the project is worth showing even where git has nothing to report,
 * because the session's relationship to it is a fact independent of git.
 */
export function GitStatusBadge({
  className,
  showBranchStatus = true,
  showProjectName = false,
  target,
}: {
  className?: string;
  /**
   * Render the branch ref, the ahead/behind counts, and the actions popover.
   *
   * Off makes this a plain, non-interactive chip. The popover is not separately
   * controllable on purpose: opening it performs a real network `git fetch`,
   * and it opens on hover — so in a list, running the pointer down the rows
   * would fire one per project passed over. A badge that is deliberately not
   * showing branch state should not be offering "merge" and "check out" either.
   */
  showBranchStatus?: boolean;
  /** Render the project's name, taken from the target's path. */
  showProjectName?: boolean;
  target?: GitTarget;
}) {
  const { data } = useGitStatus(target);
  const queryClient = useQueryClient();
  const [outcome, setOutcome] = useState<ActionOutcome | null>(null);

  const label = describeGitStatus(data);

  const post = async (action: GitAction | "refresh") => {
    // Both routes take the project to act on; they differ only in how they
    // validate it — the workspace listing, or this session's own links.
    const [url, payload] =
      target?.kind === "project"
        ? [`/api/projects/git`, { action, path: target.path }]
        : [`/api/sessions/${target?.sessionId}/git`, { action, path: target?.path }];
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return (await res.json()) as ActionOutcome;
  };

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: gitStatusQueryKey(target) });

  const run = useMutation<ActionOutcome, Error, GitAction>({
    mutationFn: post,
    onSuccess: (result) => {
      setOutcome(result);
      // The branch or the counts just moved; re-read rather than guess.
      invalidate();
    },
    onError: (error) => setOutcome({ ok: false, message: error.message }),
  });

  /**
   * Opening the popover fetches, and waits.
   *
   * This is the moment somebody asks what the branch is actually doing, right
   * before acting on the answer, so it ignores the poll's once-a-minute
   * throttle. It matters most for cards, whose workspace read never fetches at
   * all — dozens of cards must not mean dozens of network connections — but a
   * session's last background fetch can be nearly a minute old too.
   */
  const refresh = useMutation({
    mutationFn: () => post("refresh"),
    onSettled: invalidate,
  });

  const projectName = showProjectName ? projectNameOf(target) : null;

  // Nothing to say at all. A named badge survives a silent git; an unnamed one
  // has nothing left to render.
  if (!label && !projectName) return null;

  const face = (
    <>
      <GitBranch className="size-3.5 shrink-0" />
      {projectName && <span className="max-w-32 truncate">{projectName}</span>}
      {showBranchStatus && label && (
        <>
          <span className="max-w-40 truncate font-mono">{label.ref}</span>
          {label.ahead !== null && (
            <span className="flex items-center tabular-nums" aria-label={`${label.ahead} ahead`}>
              <ArrowUp className="size-3" />
              {label.ahead}
            </span>
          )}
          {label.behind !== null && (
            <span className="flex items-center tabular-nums" aria-label={`${label.behind} behind`}>
              <ArrowDown className="size-3" />
              {label.behind}
            </span>
          )}
        </>
      )}
    </>
  );

  const faceClassName = cn(
    "flex items-center gap-1.5 rounded px-1 text-xs text-muted-foreground transition-colors",
    className,
  );

  // No branch state, no actions to offer, so nothing to open — and nothing that
  // would fetch on hover. See showBranchStatus.
  if (!showBranchStatus) {
    return (
      <span className={faceClassName} title={projectName ?? label?.title}>
        {face}
      </span>
    );
  }

  const base = data?.base ?? null;
  const targetBranch = branchNameFromBase(base);
  const behind = data?.behind ?? 0;

  // Both actions need somewhere to go, and neither is worth offering when it
  // would be a no-op: nothing to merge, or already standing on the branch.
  const canMerge = Boolean(base && data?.branch) && behind > 0;
  const canCheckout = Boolean(targetBranch) && data?.branch !== targetBranch;

  return (
    <Popover
      onOpenChange={(open) => {
        if (open) refresh.mutate();
        else setOutcome(null);
      }}
    >
      <PopoverTrigger
        closeDelay={200}
        delay={250}
        openOnHover
        render={
          // A real <button>, not a styled span: this opens a menu of actions,
          // so it needs the native semantics keyboard and assistive tech rely
          // on. The explicit type stays whatever chrome hosts this — it sat in
          // the prompt toolbar's <form> once, where an implicit submit would
          // have fired the prompt, and nothing stops it being placed there again.
          <button
            className={cn(faceClassName, "hover:text-foreground")}
            // A project card is itself a button that opens a session. Without
            // this, using the indicator would also navigate away from it.
            onClick={(event) => event.stopPropagation()}
            title={label?.title}
            type="button"
          />
        }
      >
        {face}
      </PopoverTrigger>

      <PopoverContent
        align="end"
        className="w-72 p-3"
        onClick={(event) => event.stopPropagation()}
        side="bottom"
      >
        <p className="text-xs leading-relaxed text-muted-foreground">
          {label
            ? label.title
            : `No branch to report for ${projectName} — it may not be a repository yet.`}
        </p>

        <div className="mt-3 flex flex-col gap-1.5">
          <Button
            className="justify-start"
            disabled={!canMerge || run.isPending || refresh.isPending}
            onClick={() => run.mutate("merge")}
            size="sm"
            type="button"
            variant="outline"
          >
            <GitMerge className="size-3.5" />
            {base ? `Merge in ${base}` : "Merge in canonical branch"}
          </Button>
          <Button
            className="justify-start"
            disabled={!canCheckout || run.isPending || refresh.isPending}
            onClick={() => run.mutate("checkout")}
            size="sm"
            type="button"
            variant="outline"
          >
            <GitBranch className="size-3.5" />
            {targetBranch ? `Check out ${targetBranch}` : "Check out canonical branch"}
          </Button>
        </div>

        {!canMerge && behind === 0 && base && !refresh.isPending && (
          <p className="mt-2 text-[11px] text-muted-foreground/70">
            Nothing to merge — no commits on {base} that you lack.
          </p>
        )}

        {refresh.isPending && (
          <p className="mt-2 text-[11px] text-muted-foreground">
            Fetching {base ?? "remote"}…
          </p>
        )}

        {run.isPending && (
          <p className="mt-2 text-[11px] text-muted-foreground">Working…</p>
        )}

        {outcome && !run.isPending && (
          <p
            className={`mt-2 text-[11px] ${outcome.ok ? "text-muted-foreground" : "text-destructive"}`}
            role="status"
          >
            {outcome.message}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
