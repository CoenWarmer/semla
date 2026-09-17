"use client";

/**
 * The per-kind output row on a session card: how many diffs, commits and PRs
 * this session produced, and a handful of clickable chips for the newest of
 * them.
 *
 * Renders nothing when a session produced nothing — the common case for a
 * session that only read code or is still mid-turn — so it costs nothing
 * visually on rows that have no story to tell.
 *
 * The click-through into ReviewPanel (select file, scroll to hunk) is wired
 * through `onOpenArtifact`: this component just forwards a click with the
 * fully-formed `ArtifactChip`, and `sessions-list-client.tsx` turns that into
 * an `ElementTargetProvider` request (see `artifactTargetFor` in
 * session-artifact-click.ts).
 */
import {
  FileDiffIcon,
  FileTextIcon,
  GitCommitHorizontalIcon,
  GitPullRequestIcon,
  MapIcon,
} from "lucide-react";
import { SpecChipPopover } from "@/components/sidebar/spec-chip-popover";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import type { ArtifactChip, ArtifactSummary } from "@/lib/artifacts/artifact-summary";

/** How many chips a row shows before collapsing the rest into "+N". */
export const VISIBLE_ARTIFACT_CHIPS = 4;

function CountStrip({ summary }: { summary: ArtifactSummary }) {
  // Requirements first, outcomes after — reads left-to-right as cause then
  // effect, matching what the spec chip's popover shows.
  const counts: { icon: typeof FileDiffIcon; value: number; label: string }[] = [
    { icon: FileTextIcon, value: summary.specs, label: "spec" },
    // Between requirement and outcome, which is what a plan is. Plans are
    // also counted in `diffs` — they ARE diffs — so this strip shows where
    // the work stands, not a partition of it.
    { icon: MapIcon, value: summary.plans, label: "plan" },
    { icon: FileDiffIcon, value: summary.diffs, label: "diff" },
    { icon: GitCommitHorizontalIcon, value: summary.commits, label: "commit" },
    { icon: GitPullRequestIcon, value: summary.prs, label: "PR" },
  ];
  const shown = counts.filter((count) => count.value > 0);
  if (shown.length === 0) return null;

  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {shown.map(({ icon: Icon, value, label }) => (
        <span
          className="flex items-center gap-0.5"
          key={label}
          title={`${value} ${label}${value === 1 ? "" : "s"}`}
        >
          <Icon className="size-3" />
          {value}
        </span>
      ))}
    </span>
  );
}

/** Pure so the muted/title rule is testable without JSX. */
export function chipDisplay(chip: ArtifactChip): { muted: boolean; title: string } {
  const muted = chip.attribution === "turn";
  if (chip.kind === "spec") {
    // A spec has no project path and is never muted for attribution — it was
    // stated, not captured ambiguously. The native tooltip is the cheapest
    // honest "show me the requirement" without duplicating the popover.
    return { muted: false, title: chip.spec?.text ?? "" };
  }

  // Each clause names a different uncertainty, so they are listed rather
  // than collapsed: a turn-attributed artifact was not traced to one call, a
  // turnId-less one can never be traced to a requirement, and an inferred
  // role is a guess from the path. An operator seeing "plan" deserves to
  // know which of those applies.
  const notes: string[] = [];
  // The ambiguity REPLACES the project path when muted rather than joining
  // it: a chip that cannot be traced to one call has a project that is
  // itself a guess, so leading with it would dress up the weaker claim as
  // the stronger one. Pinned by this file's test.
  if (muted) notes.push("Not attributable to a single tool call");
  else if (chip.projectPath) notes.push(chip.projectPath);
  if (chip.unattributable) {
    notes.push("No turn id — cannot be linked to a requirement (captured before turn ids)");
  }
  if (chip.role) {
    notes.push(
      chip.role.source === "declared"
        ? `Declared as a ${chip.role.name}`
        : `Looks like a ${chip.role.name} (guessed from its path)`,
    );
  }

  return { muted, title: notes.join(" · ") };
}

function ArtifactChipButton({
  chip,
  chipsByKey,
  onOpen,
}: {
  chip: ArtifactChip;
  chipsByKey: Record<string, ArtifactChip>;
  onOpen: (chip: ArtifactChip) => void;
}) {
  const { muted, title } = chipDisplay(chip);

  // A spec has no file, no hunk, no commit and no url — there is nothing for
  // ElementTarget to open (see artifactTargetFor's docblock). It renders as a
  // popover instead, whose "produced" rows reuse onOpen for the artifacts
  // that DO have a target.
  if (chip.kind === "spec") {
    return (
      <Popover>
        <PopoverTrigger
          className="relative z-10 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent"
          title={title}
        >
          {chip.label}
        </PopoverTrigger>
        <SpecChipPopover chip={chip} chipsByKey={chipsByKey} onOpenArtifact={onOpen} />
      </Popover>
    );
  }

  // A PR chip has no re-findable target in this app — it opens the PR itself
  // rather than routing through the panel, which is why it is an <a> and does
  // not call onOpen.
  if (chip.kind === "pr" && chip.url) {
    return (
      <a
        className="relative z-10 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent"
        href={chip.url}
        rel="noreferrer"
        target="_blank"
        title={chip.url}
      >
        {chip.label}
      </a>
    );
  }

  // A plan chip keeps the diff's click-through — that is the whole reason a
  // role beat a fifth ArtifactKind — and only adds an icon and a dotted
  // underline when the role was inferred rather than declared.
  const isPlan = chip.role?.name === "plan";
  return (
    <button
      className="relative z-10 flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent disabled:opacity-70"
      disabled={chip.target === null}
      onClick={() => onOpen(chip)}
      style={muted ? { opacity: 0.7 } : undefined}
      title={title}
      type="button"
    >
      {isPlan && <MapIcon className="size-3 shrink-0" />}
      <span
        className={
          chip.role?.source === "inferred"
            ? "underline decoration-dotted underline-offset-2"
            : undefined
        }
      >
        {chip.label}
      </span>
    </button>
  );
}

/**
 * Split a summary's chips into what fits the row and what collapses into
 * "+N". Pure and exported so the split is tested without rendering JSX —
 * this repo runs no jsdom.
 */
export function splitArtifactChips(summary: ArtifactSummary): {
  visible: ArtifactChip[];
  overflow: ArtifactChip[];
} {
  return {
    overflow: summary.chips.slice(VISIBLE_ARTIFACT_CHIPS),
    visible: summary.chips.slice(0, VISIBLE_ARTIFACT_CHIPS),
  };
}

/** Whether the row has anything at all to show. */
export function hasArtifactsToShow(summary: ArtifactSummary): boolean {
  // `plans` is deliberately absent: a plan is also counted in `diffs`, so a
  // summary with a plan already has a non-zero diff count. Testing it here
  // would be dead logic that reads as though plans could stand alone.
  return summary.diffs > 0 || summary.commits > 0 || summary.prs > 0 || summary.specs > 0;
}

export function SessionArtifactChips({
  summary,
  onOpenArtifact,
}: {
  summary: ArtifactSummary;
  onOpenArtifact: (chip: ArtifactChip) => void;
}) {
  if (!hasArtifactsToShow(summary)) {
    return null;
  }

  const { visible, overflow } = splitArtifactChips(summary);

  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <CountStrip summary={summary} />
      {visible.map((chip) => (
        <ArtifactChipButton
          chip={chip}
          chipsByKey={summary.chipsByKey}
          key={chip.key}
          onOpen={onOpenArtifact}
        />
      ))}
      {overflow.length > 0 && (
        <span
          className="relative z-10 text-xs text-muted-foreground"
          title={overflow.map((chip) => chip.label).join(", ")}
        >
          +{overflow.length}
        </span>
      )}
    </span>
  );
}
