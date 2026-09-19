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
import { AnimatePresence, motion } from "motion/react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { FileDiff, Hunk } from "@/lib/review/review-types";

import { hunkAnchorLine, hunkAnchorText } from "./review-decorations";
import { hunkRangeKey } from "./review-hunk-match";

/** A one-line summary of what a hunk does, without opening it. */
export function hunkSummary(hunk: Hunk): { added: number; removed: number } {
  return {
    added: hunk.lines.filter((line) => line.kind === "added").length,
    removed: hunk.lines.filter((line) => line.kind === "removed").length,
  };
}

const maxSnippetLength = 60;

/** Where in the file a hunk sits, in the terms the editor's gutter shows.
 *
 * Leads with a snippet of the anchor line itself — the actual changed
 * line — rather than git's own `@@` heading, since that heading names the
 * enclosing region, not the change. Falls back to the heading only when the
 * anchor line has no usable text (a pure-removals hunk, or a blank line). */
export const hunkLocation = (hunk: Hunk): string => {
  const anchor = hunkAnchorLine(hunk);
  const snippet = hunkAnchorText(hunk);
  if (snippet !== null) {
    const truncated =
      snippet.length > maxSnippetLength
        ? `${snippet.slice(0, maxSnippetLength)}…`
        : snippet;
    return `${anchor} · ${truncated}`;
  }
  return hunk.heading ? `${anchor} · ${hunk.heading}` : `line ${anchor}`;
};

function HunkRow({
  busy,
  current = false,
  direction,
  hunk,
  layoutId,
  onApply,
  onReveal,
  readOnly = false,
}: {
  busy: boolean;
  /** The hunk the keyboard cursor is on — see review-hunk-keyboard.ts. */
  current?: boolean;
  direction: "stage" | "unstage";
  hunk: Hunk;
  /**
   * This hunk's identity across the staged/unstaged boundary, scoped to its
   * file. See `hunkRangeKey` for why a range rather than `Hunk.index`, and
   * `Group` for the file-path scoping — layoutId is global across every
   * `ReviewHunkList` mounted at once, so two files' hunks with identical
   * ranges must not collide.
   */
  layoutId: string;
  onApply: () => void;
  onReveal: () => void;
  readOnly?: boolean;
}) {
  const { added, removed } = hunkSummary(hunk);

  return (
    <motion.div
      className="flex items-center gap-1 pr-1"
      exit={{ opacity: 0 }}
      layout="position"
      layoutId={layoutId}
      transition={{ duration: 0.22, ease: "easeInOut" }}
    >
      <button
        // A ring rather than a background fill: the selected *file*'s row
        // already uses `bg-accent`, and the two marks have to stay tellable
        // apart when the cursor is inside the selected file — which is the
        // usual case rather than an edge one.
        className={cn(
          "min-w-0 flex-1 truncate rounded px-2 py-1 text-left text-[11px] transition-colors hover:bg-accent/50",
          current && "ring-1 ring-inset ring-primary bg-accent/30",
        )}
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

      {/* Omitted rather than disabled when read-only: a greyed button says
          "not right now", and there is no later in which a commit's hunk
          becomes stageable. */}
      {readOnly ? null : (
        <Button
          aria-label={
            direction === "stage" ? "Stage this hunk" : "Unstage this hunk"
          }
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
      )}
    </motion.div>
  );
}

function Group({
  busy,
  currentIndex = null,
  diff,
  direction,
  onlyShowStaged = false,
  onApply,
  onReveal,
  readOnly = false,
  title,
}: {
  busy: boolean;
  /** `Hunk.index` within this group that the keyboard cursor is on. */
  currentIndex?: number | null;
  diff: FileDiff | null;
  direction: "stage" | "unstage";
  onlyShowStaged?: boolean;
  onApply: (hunks: number[]) => void;
  onReveal: (line: number) => void;
  readOnly?: boolean;
  title: string;
}) {
  const hunks = diff?.hunks ?? [];

  // A file whose change carries no hunks — a mode change, a rename with no
  // edits — is still stageable, and an empty group would make it look as
  // though there were nothing there.
  const hunkless = diff !== null && hunks.length === 0 && !diff.binary;
  const heading = readOnly ? null : title;

  if (!diff || (hunks.length === 0 && !hunkless)) return null;

  return (
    <div className="flex flex-col gap-0.5">
      {/*conlyShowStaged || heading === null ? null : (
        <div className="flex items-center gap-2 px-2 pb-0.5">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {heading}
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
      )*/}

      {hunkless ? (
        <p className="px-2 pb-1 text-[11px] text-muted-foreground">
          {diff.modeChangeOnly
            ? "A mode change, with no lines to choose between."
            : "No lines changed."}
        </p>
      ) : (
        <AnimatePresence mode="popLayout">
          {hunks.map((hunk) => (
            <HunkRow
              key={hunk.index}
              busy={busy}
              current={hunk.index === currentIndex}
              direction={direction}
              hunk={hunk}
              layoutId={`${diff.path}:${hunkRangeKey(hunk)}`}
              onApply={() => onApply([hunk.index])}
              onReveal={() => onReveal(hunkAnchorLine(hunk))}
              readOnly={readOnly}
            />
          ))}
        </AnimatePresence>
      )}
    </div>
  );
}

export function ReviewHunkList({
  busy,
  currentHunk = null,
  onlyShowStaged = false,
  onReveal,
  onStage,
  readOnly = false,
  staged,
  unstaged,
  untracked,
}: {
  busy: boolean;
  /**
   * The hunk the keyboard cursor is on, or null when it is in another file.
   *
   * Group-relative, because the two groups are numbered independently — the
   * same reason `onStage` takes a direction. See review-hunk-cursor.ts.
   */
  currentHunk?: { group: "staged" | "unstaged"; index: number } | null;
  onlyShowStaged?: boolean;
  onReveal: (line: number) => void;
  onStage: (hunks: number[], direction: "stage" | "unstage") => void;
  /**
   * There is nothing to stage and no later in which there will be — these
   * hunks are a commit's, so it is the *history* being shown, not a working
   * copy. Suppresses every apply control and both group headings, which are
   * about the index and would be a lie here.
   */
  readOnly?: boolean;
  staged: FileDiff | null;
  unstaged: FileDiff | null;
  untracked: boolean;
}) {
  if (untracked && !readOnly) {
    return (
      <div className="flex flex-col gap-2 px-2 py-2">
        <p className="text-[11px] text-muted-foreground">This file is new.</p>
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
        currentIndex={
          currentHunk?.group === "staged" ? currentHunk.index : null
        }
        diff={staged}
        direction="unstage"
        onlyShowStaged
        onApply={(hunks) => onStage(hunks, "unstage")}
        onReveal={onReveal}
        readOnly={readOnly}
        title="Staged"
      />
      <Group
        busy={busy}
        currentIndex={
          currentHunk?.group === "unstaged" ? currentHunk.index : null
        }
        diff={unstaged}
        direction="stage"
        onlyShowStaged={onlyShowStaged}
        onApply={(hunks) => onStage(hunks, "stage")}
        onReveal={onReveal}
        readOnly={readOnly}
        title="Not staged"
      />
      {nothing && !staged && !unstaged ? (
        <p className="px-2 text-[11px] text-muted-foreground">
          {readOnly
            ? "This commit changed no lines in this file."
            : "Nothing to stage in this file."}
        </p>
      ) : null}
    </div>
  );
}
