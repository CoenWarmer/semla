/**
 * A session's artifacts grouped into one row per kind, for a list that links
 * to each one.
 *
 * The summary card used to render `ArtifactSummary`'s counts as a single
 * strip — "1 spec · 1 plan · 12 uncommitted diffs" — which is a headline, not
 * a way in. These groups exist so each kind gets its own row and every entry
 * is clickable, so this module is built on the *chips* rather than on those
 * counts. Two consequences worth stating, because they make the numbers here
 * differ from the strip's on purpose:
 *
 *  - **Counts come from the chips, not from `ArtifactSummary`.** An artifact
 *    with nothing to open produces no chip (a diff whose file list is empty
 *    counts towards `diffs` and yields nothing to click — see `chipFor`). A
 *    row that says "12" and lists 11 links would be wrong about itself, so a
 *    group counts what it can actually offer.
 *  - **`chipsByKey`, not `chips`.** The latter is capped at `CHIP_CAP` for a
 *    crowded sidebar row; a list wants everything the session produced.
 *
 * Plans are partitioned out of diffs rather than shown alongside them. A plan
 * *is* a diff (see diff-role.ts), and `ArtifactSummary` deliberately counts it
 * in both — which is right for a count strip, where the two numbers answer
 * different questions, and wrong for a list of links, where it would render
 * the same file as a row under "Plans" and again under "Uncommitted diffs".
 * `artifact-summary.ts` warns that the two must never be added together; for a
 * list, partitioning is how that warning is obeyed.
 */

import type { ArtifactChip, ArtifactSummary } from "@/lib/artifacts/artifact-summary";

/**
 * A row in the list.
 *
 * Not `ArtifactKind`: "plan" is a diff whose role says so, and separating it
 * here is the partition described above. This is a display grouping, which is
 * why it lives beside the card that renders it rather than in
 * artifact-types.ts with the persisted shapes.
 */
export type ArtifactGroupKind = "spec" | "plan" | "diff" | "commit" | "pr";

export interface ArtifactGroup {
  kind: ArtifactGroupKind;
  /** Singular label; the renderer pluralises against `chips.length`. */
  label: string;
  /** Newest first, uncapped. */
  chips: ArtifactChip[];
}

/** Display order: requirement, then plan, then the work, then its outcomes. */
const GROUP_ORDER: { kind: ArtifactGroupKind; label: string }[] = [
  { kind: "spec", label: "spec" },
  { kind: "plan", label: "plan" },
  { kind: "diff", label: "uncommitted diff" },
  { kind: "commit", label: "commit" },
  { kind: "pr", label: "PR" },
];

/** Which row a chip belongs in. */
export function groupKindOf(chip: ArtifactChip): ArtifactGroupKind {
  if (chip.kind === "diff" && chip.role?.name === "plan") return "plan";
  return chip.kind;
}

/**
 * Newest first, ties broken by key.
 *
 * Restated here rather than imported: `byRecency` is private to
 * artifact-summary.ts, and a group's order has to be stable for its own
 * reason — these are list rows with keys, and an unstable sort would reorder
 * them under React on every poll.
 */
function byRecency(a: ArtifactChip, b: ArtifactChip): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * One group per kind that produced anything, in display order.
 *
 * Empty groups are omitted rather than rendered at zero: a session that
 * committed nothing should not carry a "0 commits" row for the life of the
 * page.
 */
export function artifactGroups(
  summary: ArtifactSummary | null | undefined,
): ArtifactGroup[] {
  if (!summary) return [];

  const byKind = new Map<ArtifactGroupKind, ArtifactChip[]>();
  // Uncapped, and deduped by construction: chipsByKey is keyed on the
  // artifact key, so the same artifact cannot land in a group twice.
  for (const chip of Object.values(summary.chipsByKey)) {
    const kind = groupKindOf(chip);
    const existing = byKind.get(kind);
    if (existing) existing.push(chip);
    else byKind.set(kind, [chip]);
  }

  const groups: ArtifactGroup[] = [];
  for (const { kind, label } of GROUP_ORDER) {
    const chips = byKind.get(kind);
    if (chips && chips.length > 0) {
      groups.push({ chips: chips.sort(byRecency), kind, label });
    }
  }

  return groups;
}

/** A group's heading: "12 uncommitted diffs". */
export const groupHeading = (group: ArtifactGroup): string =>
  `${group.chips.length} ${group.label}${group.chips.length === 1 ? "" : "s"}`;

/**
 * What a chip's row shows as its own line.
 *
 * A diff chip's label is a file count ("1 file", "3 files"), which says
 * nothing about *which* file on a row whose whole purpose is to open one — so
 * a diff falls back to its target path. A plan already labels itself with its
 * own name, and a commit with its sha and subject, so both keep theirs.
 */
export function chipRowLabel(chip: ArtifactChip): string {
  if (chip.kind === "diff" && chip.role?.name !== "plan" && chip.target) {
    return chip.target.path;
  }
  return chip.label;
}
