"use client";

/**
 * Forking a conversation at this message.
 *
 * Shared by both roles, the way CopyMessageButton is: a fork can start from
 * anything said, not only from a prompt.
 *
 * Clicking does not itself create a branch — see
 * docs/plans/branching-sessions.md §3. It only marks where the *next* prompt
 * will land; the caller is what truncates the visible conversation and shows
 * the "forked here" affordance. This component is just the button.
 */
import { GitForkIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export function ForkMessageButton({
  className,
  disabled = false,
  onFork,
}: {
  className?: string;
  disabled?: boolean;
  onFork: () => void;
}) {
  return (
    <button
      className={cn(
        "shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 disabled:cursor-not-allowed disabled:opacity-0 group-hover/message:opacity-100",
        className,
      )}
      disabled={disabled}
      onClick={onFork}
      title={
        disabled
          ? "Wait for the current turn to finish"
          : "Continue from here on a new branch"
      }
      type="button"
    >
      <GitForkIcon className="size-3.5" />
      <span className="sr-only">Continue from here on a new branch</span>
    </button>
  );
}
