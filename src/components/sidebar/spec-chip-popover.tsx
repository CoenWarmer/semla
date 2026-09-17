"use client";

/**
 * The content of a spec chip's popover: the requirement itself, and what it
 * is answerable for.
 *
 * Split out of session-artifacts.tsx because it is the one chip kind with
 * real content to show rather than a target to open — see
 * ArtifactChipButton's spec branch, which renders this inside `Popover`.
 * `Popover`'s own open/closed state is uncontrolled here on purpose: there is
 * nothing to derive it from, so there is no effect for
 * react/set-state-in-effect to flag.
 *
 * Clicking a "produced" row reuses the existing ElementTarget protocol: it
 * calls `onOpenArtifact` with the FULL chip for that artifact (looked up in
 * `chipsByKey`, not reconstructed), the same callback `ArtifactChipButton`
 * itself uses — no new click protocol.
 *
 * Weaker than it may look: a "same-turn" row is exact (the artifact shares
 * this spec's turnId); an "after" row is a window — the nearest artifact
 * that falls between this spec and the next one in the session — and says
 * "produced under this requirement", not "caused by it". See
 * spec-attribution.ts's docblock for why, including the one case this
 * cannot fix: a workflow subagent's edits never reach the turn-event router
 * and land on the host's next tool call and turnId, so a "same-turn" row can
 * name work that had nothing to do with this requirement.
 */
import {
  FileDiffIcon,
  FileTextIcon,
  GitCommitHorizontalIcon,
  GitPullRequestIcon,
} from "lucide-react";
import {
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
} from "@/components/ui/popover";
import type { ArtifactChip, ArtifactChipCaused } from "@/lib/artifacts/artifact-summary";
import type { ArtifactKind } from "@/lib/artifacts/artifact-types";

const KIND_ICON: Record<ArtifactKind, typeof FileDiffIcon> = {
  commit: GitCommitHorizontalIcon,
  diff: FileDiffIcon,
  pr: GitPullRequestIcon,
  spec: FileTextIcon,
};

/** The popover's header line, pure so it is testable without JSX. */
export function specChipHeader(chip: ArtifactChip): string {
  if (chip.spec?.source === "form") return "Feature spec";
  const turnIndex = chip.spec?.turnIndex;
  return turnIndex === null || turnIndex === undefined ? "@spec" : `@spec · turn ${turnIndex}`;
}

/** English for the strength badge next to a "produced" row. */
export function strengthLabel(strength: ArtifactChipCaused["strength"]): string {
  return strength === "same-turn" ? "this turn" : "after";
}

export function SpecChipPopover({
  chip,
  chipsByKey,
  onOpenArtifact,
}: {
  chip: ArtifactChip;
  /** Uncapped lookup so a "produced" row can be re-opened even if its own
   * chip was pushed off the visible CHIP_CAP list. */
  chipsByKey: Record<string, ArtifactChip>;
  onOpenArtifact: (chip: ArtifactChip) => void;
}) {
  if (!chip.spec) return null;
  const { spec } = chip;
  const rows = chip.caused ?? [];

  return (
    <PopoverContent className="w-80">
      <PopoverHeader>
        <PopoverTitle>{specChipHeader(chip)}</PopoverTitle>
        {chip.turnId ? (
          <span className="select-all text-xs text-muted-foreground">{chip.turnId}</span>
        ) : null}
      </PopoverHeader>
      <PopoverDescription className="whitespace-pre-wrap text-foreground">
        {spec.source === "form" && spec.fields.length > 0 ? (
          <dl className="flex flex-col gap-1">
            {spec.fields.map((field) => (
              <div key={field.label}>
                <dt className="text-xs font-medium text-muted-foreground">{field.label}</dt>
                <dd className="text-sm">{field.value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          spec.text
        )}
      </PopoverDescription>
      {rows.length > 0 && (
        <div className="flex flex-col gap-1 border-t pt-2">
          <span className="text-xs font-medium text-muted-foreground">Produced</span>
          {rows.map((row) => {
            const Icon = KIND_ICON[row.kind];
            const target = chipsByKey[row.key];
            return (
              <button
                className="flex items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs hover:bg-accent disabled:opacity-70"
                disabled={!target}
                key={row.key}
                onClick={() => target && onOpenArtifact(target)}
                type="button"
              >
                <Icon className="size-3 shrink-0" />
                <span className="truncate">{row.label}</span>
                <span className="ml-auto shrink-0 text-muted-foreground">
                  {strengthLabel(row.strength)}
                </span>
              </button>
            );
          })}
          {(chip.causedOverflow ?? 0) > 0 && (
            <span className="text-xs text-muted-foreground">+{chip.causedOverflow} more</span>
          )}
        </div>
      )}
    </PopoverContent>
  );
}
