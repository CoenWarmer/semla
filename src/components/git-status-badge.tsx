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

/**
 * Branch and divergence for the session's project, with the two moves you
 * usually want next: take the canonical branch's commits, or go stand on it.
 *
 * Renders nothing at all when there is nothing to say — no session, no project
 * attached, or a directory that is not a repository. An empty slot reads
 * better here than a placeholder next to the model picker.
 */
export function GitStatusBadge({
  className,
  target,
}: {
  className?: string;
  target?: GitTarget;
}) {
  const { data } = useGitStatus(target);
  const queryClient = useQueryClient();
  const [outcome, setOutcome] = useState<ActionOutcome | null>(null);

  const label = describeGitStatus(data);

  const post = async (action: GitAction | "refresh") => {
    const [url, payload] =
      target?.kind === "project"
        ? [`/api/projects/git`, { action, path: target.path }]
        : [`/api/sessions/${target?.sessionId}/git`, { action }];
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
   * Workspace reads never fetch — dozens of cards must not mean dozens of
   * network connections — so opening a card's popover is what brings that one
   * repository up to date.
   */
  const refreshOnOpen = () => {
    if (target?.kind !== "project") return;
    void post("refresh").then(invalidate).catch(() => {});
  };

  if (!label) return null;

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
        if (open) refreshOnOpen();
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
            className={cn(
              "flex items-center gap-1.5 rounded px-1 text-xs text-muted-foreground transition-colors hover:text-foreground",
              className,
            )}
            // A project card is itself a button that opens a session. Without
            // this, using the indicator would also navigate away from it.
            onClick={(event) => event.stopPropagation()}
            title={label.title}
            type="button"
          />
        }
      >
        <GitBranch className="size-3.5 shrink-0" />
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
      </PopoverTrigger>

      <PopoverContent
        align="end"
        className="w-72 p-3"
        onClick={(event) => event.stopPropagation()}
        side="bottom"
      >
        <p className="text-xs leading-relaxed text-muted-foreground">{label.title}</p>

        <div className="mt-3 flex flex-col gap-1.5">
          <Button
            className="justify-start"
            disabled={!canMerge || run.isPending}
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
            disabled={!canCheckout || run.isPending}
            onClick={() => run.mutate("checkout")}
            size="sm"
            type="button"
            variant="outline"
          >
            <GitBranch className="size-3.5" />
            {targetBranch ? `Check out ${targetBranch}` : "Check out canonical branch"}
          </Button>
        </div>

        {!canMerge && behind === 0 && base && (
          <p className="mt-2 text-[11px] text-muted-foreground/70">
            Nothing to merge — no commits on {base} that you lack.
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
