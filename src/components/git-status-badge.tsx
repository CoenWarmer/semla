"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, GitBranch, GitMerge } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useGitStatus } from "@/hooks/use-git-status";
import { branchNameFromBase, describeGitStatus } from "@/lib/git-status-display";

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
export function GitStatusBadge({ sessionId }: { sessionId?: string }) {
  const { data } = useGitStatus(sessionId);
  const queryClient = useQueryClient();
  const [outcome, setOutcome] = useState<ActionOutcome | null>(null);

  const label = describeGitStatus(data);

  const run = useMutation<ActionOutcome, Error, GitAction>({
    mutationFn: async (action) => {
      const res = await fetch(`/api/sessions/${sessionId}/git`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      return (await res.json()) as ActionOutcome;
    },
    onSuccess: (result) => {
      setOutcome(result);
      // The branch or the counts just moved; re-read rather than guess.
      void queryClient.invalidateQueries({ queryKey: ["git-status", sessionId] });
    },
    onError: (error) => setOutcome({ ok: false, message: error.message }),
  });

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
        if (!open) setOutcome(null);
      }}
    >
      <PopoverTrigger
        closeDelay={200}
        delay={250}
        openOnHover
        render={
          <span
            className="flex cursor-default items-center gap-1.5 rounded px-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            title={label.title}
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

      <PopoverContent align="start" className="w-72 p-3" side="top">
        <p className="text-xs leading-relaxed text-muted-foreground">{label.title}</p>

        <div className="mt-3 flex flex-col gap-1.5">
          <Button
            className="justify-start"
            disabled={!canMerge || run.isPending}
            onClick={() => run.mutate("merge")}
            size="sm"
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
