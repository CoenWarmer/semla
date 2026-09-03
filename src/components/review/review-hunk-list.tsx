"use client";

/**
 * The hunks of the open file, in two groups: what is staged and what is not.
 *
 * Two groups rather than one list with checkboxes, because the underlying
 * diffs really are two. Staging selects from the worktree against the index;
 * unstaging selects from the index against HEAD. Their hunks are numbered
 * independently, so a single list pretending to span both would be a UI whose
 * checkbox meant different things depending on where the line came from.
 */

import { MinusIcon, PlusIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { FileDiff, Hunk } from "@/lib/review-types";

/** A one-line summary of what a hunk does, without opening it. */
export function hunkSummary(hunk: Hunk): { added: number; removed: number } {
  return {
    added: hunk.lines.filter((line) => line.kind === "added").length,
    removed: hunk.lines.filter((line) => line.kind === "removed").length,
  };
}

/** Where in the file a hunk sits, in the terms the editor's gutter shows. */
export const hunkLocation = (hunk: Hunk): string =>
  hunk.heading ? `${hunk.newStart} · ${hunk.heading}` : `line ${hunk.newStart}`;

function HunkRow({
  busy,
  direction,
  hunk,
  onApply,
  onReveal,
}: {
  busy: boolean;
  direction: "stage" | "unstage";
  hunk: Hunk;
  onApply: () => void;
  onReveal: () => void;
}) {
  const { added, removed } = hunkSummary(hunk);

  return (
    <div className="flex items-center gap-1 pr-1">
      <button
        className="min-w-0 flex-1 truncate rounded px-2 py-1 text-left text-[11px] transition-colors hover:bg-accent/50"
        onClick={onReveal}
        title={`Go to ${hunkLocation(hunk)}`}
        type="button"
      >
        <span className="text-muted-foreground">{hunkLocation(hunk)}</span>
        {added > 0 ? (
          <span className="ml-1.5 text-emerald-500">+{added}</span>
        ) : null}
        {removed > 0 ? (
          <span className="ml-1 text-destructive">−{removed}</span>
        ) : null}
      </button>

      <Button
        aria-label={direction === "stage" ? "Stage this hunk" : "Unstage this hunk"}
        className="size-6 shrink-0"
        disabled={busy}
        onClick={onApply}
        size="icon"
        title={direction === "stage" ? "Stage this hunk" : "Unstage this hunk"}
        variant="ghost"
      >
        {direction === "stage" ? (
          <PlusIcon className="size-3.5" />
        ) : (
          <MinusIcon className="size-3.5" />
        )}
      </Button>
    </div>
  );
}

function Group({
  busy,
  diff,
  direction,
  onApply,
  onReveal,
  title,
}: {
  busy: boolean;
  diff: FileDiff | null;
  direction: "stage" | "unstage";
  onApply: (hunks: number[]) => void;
  onReveal: (line: number) => void;
  title: string;
}) {
  const hunks = diff?.hunks ?? [];

  // A file whose change carries no hunks — a mode change, a rename with no
  // edits — is still stageable, and an empty group would make it look as
  // though there were nothing there.
  const hunkless = diff !== null && hunks.length === 0 && !diff.binary;

  if (!diff || (hunks.length === 0 && !hunkless)) return null;

  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-2 px-2 pb-0.5">
        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </p>
        <Button
          className="ml-auto h-5 px-1.5 text-[10px]"
          disabled={busy}
          onClick={() => onApply(hunks.map((hunk) => hunk.index))}
          size="sm"
          variant="ghost"
        >
          {direction === "stage" ? "Stage all" : "Unstage all"}
        </Button>
      </div>

      {hunkless ? (
        <p className="px-2 pb-1 text-[11px] text-muted-foreground">
          {diff.modeChangeOnly
            ? "A mode change, with no lines to choose between."
            : "No lines changed."}
        </p>
      ) : (
        hunks.map((hunk) => (
          <HunkRow
            key={hunk.index}
            busy={busy}
            direction={direction}
            hunk={hunk}
            onApply={() => onApply([hunk.index])}
            onReveal={() => onReveal(hunk.newStart)}
          />
        ))
      )}
    </div>
  );
}

export function ReviewHunkList({
  busy,
  onReveal,
  onStage,
  staged,
  unstaged,
  untracked,
}: {
  busy: boolean;
  onReveal: (line: number) => void;
  onStage: (hunks: number[], direction: "stage" | "unstage") => void;
  staged: FileDiff | null;
  unstaged: FileDiff | null;
  untracked: boolean;
}) {
  if (untracked) {
    return (
      <div className="flex flex-col gap-2 px-2 py-2">
        <p className="text-[11px] text-muted-foreground">
          This file is new, so there is nothing to compare it against and no
          hunks to choose between. Staging it adds the whole file.
        </p>
        <Button
          className={cn("h-6 self-start px-2 text-[11px]")}
          disabled={busy}
          onClick={() => onStage([], "stage")}
          size="sm"
          variant="secondary"
        >
          Stage this file
        </Button>
      </div>
    );
  }

  const nothing = !staged?.hunks.length && !unstaged?.hunks.length;

  return (
    <div className="flex flex-col gap-3 py-2">
      <Group
        busy={busy}
        diff={unstaged}
        direction="stage"
        onApply={(hunks) => onStage(hunks, "stage")}
        onReveal={onReveal}
        title="Not staged"
      />
      <Group
        busy={busy}
        diff={staged}
        direction="unstage"
        onApply={(hunks) => onStage(hunks, "unstage")}
        onReveal={onReveal}
        title="Staged"
      />
      {nothing && !staged && !unstaged ? (
        <p className="px-2 text-[11px] text-muted-foreground">
          Nothing to stage in this file.
        </p>
      ) : null}
    </div>
  );
}
