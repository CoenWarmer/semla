/**
 * Turning a session's raw artifacts into what the sidebar renders.
 *
 * Pure and client-safe, same reason as artifact-types.ts: the sidebar is a
 * client component and reads this directly, with no server hop in between.
 */

import { attributeArtifactsToSpecs } from "@/lib/artifacts/spec-attribution";
import type {
  ArtifactAttribution,
  ArtifactKind,
  HunkAnchor,
  SessionArtifact,
  SpecField,
  SpecSource,
} from "@/lib/artifacts/artifact-types";
import type { DiffRole } from "@/lib/artifacts/diff-role";

export interface ArtifactChipTarget {
  project: string;
  path: string;
  /** The captured hunk, so the panel can re-find it. Null = open the file. */
  anchor: HunkAnchor | null;
  /** For a commit chip: which commit the panel should select. */
  commitSha: string | null;
}

/** A caused-artifact row for a spec chip's popover; see spec-attribution.ts. */
export interface ArtifactChipCaused {
  key: string;
  kind: ArtifactKind;
  label: string;
  strength: "same-turn" | "after";
}

export interface ArtifactChip {
  key: string;
  kind: ArtifactKind;
  /** Null only for a spec chip — a requirement is stated to the session, not a project. */
  projectPath: string | null;
  createdAt: string;
  /**
   * Carried through from the artifact so the sidebar can render a
   * turn-attributed chip distinctly — the ambiguity ("this wasn't traced to
   * one tool call") is meant to stay visible, not be laundered away.
   */
  attribution: ArtifactAttribution;
  /** Chip label: "3 files", "a1b2c3d fix foo", "#412", "Feature spec". */
  label: string;
  /** Where clicking lands. Null for a pr (opens its url) and for a spec. */
  target: ArtifactChipTarget | null;
  /** Present only for kind "pr". */
  url?: string;
  /**
   * Present only for kind "diff", and only when the diff has one — what the
   * file is for, plus whether that was declared or guessed. The sidebar
   * shows the two differently on purpose; see diff-role.ts.
   */
  role?: DiffRole | null;
  /**
   * True when this artifact carries no `turnId` and therefore can never be
   * joined to the requirement that caused it. Legacy-only: every artifact
   * captured under a prompt turn has had an id since turn-id.ts landed, so
   * this marks a row from before that, not a row that failed. Surfaced
   * rather than hidden so an operator reading a spec's popover knows the
   * absence is permanent and not a bug to chase — the confusion this field
   * exists to prevent cost a full debugging session once already.
   */
  unattributable?: boolean;
  /** Present only for kind "spec" — the requirement itself, for the popover. */
  spec?: {
    source: SpecSource;
    text: string;
    turnIndex: number | null;
    fields: SpecField[];
  };
  /**
   * The durable turn id, present only for kind "spec". Shown (selectable)
   * in the popover so an operator can grep this session's artifacts.jsonl
   * and SPEC.md with it. Other kinds omit it — their chip is already keyed
   * on it internally, but there is nothing for an operator to grep with a
   * bare id attached to a diff chip that a click already opens.
   */
  turnId?: string | null;
  /**
   * Present only for kind "spec" — what it is answerable for, capped at
   * SPEC_CAUSED_CAP with the remainder counted, not listed. Derived from the
   * FULL artifact list, before CHIP_CAP truncation, so a spec's "caused"
   * count is not distorted by which chips made the visible row.
   */
  caused?: ArtifactChipCaused[];
  /** How many more caused artifacts exist beyond SPEC_CAUSED_CAP. */
  causedOverflow?: number;
}

export interface ArtifactSummary {
  diffs: number;
  commits: number;
  prs: number;
  /**
   * Diffs whose role is "plan" — a SUBSET of `diffs`, not a sibling of it. A
   * plan is a diff (see diff-role.ts), so it is counted in both, and the two
   * numbers must never be added together.
   */
  plans: number;
  /**
   * Captured requirements (an @spec-marked turn or a submitted feature-spec
   * form). Counted here even though WI-1 does not yet render a spec chip
   * for one — see `chipFor` below — so the UI work in WI-3 has a real count
   * to read rather than inventing its own pass over the artifact list.
   */
  specs: number;
  /** Newest first, capped at CHIP_CAP. */
  chips: ArtifactChip[];
  /**
   * Every chip that was produced, keyed by artifact key, uncapped. A spec
   * chip's `caused` rows reference other chips by key; the popover needs the
   * full ArtifactChip (icon, label, target) to open one, not just its key —
   * and that chip may have been pushed off `chips` by CHIP_CAP.
   */
  chipsByKey: Record<string, ArtifactChip>;
}

export const CHIP_CAP = 6;
/** How many "produced" rows a spec chip's popover lists before "+N more". */
export const SPEC_CAUSED_CAP = 8;

/** Everything a diff/commit/pr artifact has in common as chip material. */
function shortSubject(subject: string, max = 48): string {
  const trimmed = subject.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/**
 * A plan chip's label: the file's own name, without directory or extension.
 *
 * `docs/plans/commit-scoped-review.md` reads as "commit-scoped-review", which
 * is what the operator named the work — far more use on a crowded row than
 * the directory it happens to sit in.
 */
function planLabel(path: string): string {
  const base = path.split("/").pop() ?? path;
  return shortSubject(base.replace(/\.mdx?$/, ""), 32);
}

/**
 * Chip for one artifact, or null when it addresses nothing renderable.
 *
 * Rules, asserted in the test:
 *  - a diff artifact with zero files yields no chip.
 *  - a diff chip targets files[0], anchor = files[0].hunks[0] ?? null,
 *    commitSha: null.
 *  - a commit chip targets files[0] when present; null target and an
 *    informational chip when there are none. commitSha = sha, anchor: null.
 *  - a pr chip has target: null, url set.
 */
export function chipFor(artifact: SessionArtifact): ArtifactChip | null {
  switch (artifact.kind) {
    case "diff": {
      if (artifact.files.length === 0) return null;
      const first = artifact.files[0];
      return {
        attribution: artifact.attribution,
        createdAt: artifact.createdAt,
        key: artifact.key,
        kind: "diff",
        // A plan says what it is; a source diff says how much it touched.
        // The file count is the wrong headline for a design document — "1
        // file" told an operator nothing about a 148-line plan.
        label:
          artifact.role?.name === "plan"
            ? planLabel(first.path)
            : artifact.files.length === 1
              ? "1 file"
              : `${artifact.files.length} files`,
        projectPath: artifact.projectPath,
        role: artifact.role,
        target: {
          anchor: first.hunks[0] ?? null,
          commitSha: null,
          path: first.path,
          project: artifact.projectPath,
        },
        unattributable: artifact.turnId === null,
      };
    }

    case "commit": {
      const first = artifact.files[0];
      return {
        attribution: artifact.attribution,
        createdAt: artifact.createdAt,
        key: artifact.key,
        kind: "commit",
        label: `${artifact.shortSha} ${shortSubject(artifact.subject)}`,
        projectPath: artifact.projectPath,
        target: first
          ? {
              anchor: null,
              commitSha: artifact.sha,
              path: first,
              project: artifact.projectPath,
            }
          : null,
      };
    }

    case "pr": {
      return {
        attribution: artifact.attribution,
        createdAt: artifact.createdAt,
        key: artifact.key,
        kind: "pr",
        label: artifact.number !== null ? `#${artifact.number}` : artifact.url,
        projectPath: artifact.projectPath,
        target: null,
        url: artifact.url,
      };
    }

    case "spec": {
      // A blank chip is meaningless here — isCapturedSpec (spec-inclusion.ts)
      // is what keeps an artifact from ever existing for an unmarked turn or
      // an all-blank form, so every SpecArtifact reaching this branch has
      // real content.
      //
      // `caused`/`causedOverflow` are NOT set here: they need the full
      // artifact list (spec-attribution.ts), which a single-artifact
      // function does not have. summarizeArtifacts fills them in below.
      return {
        attribution: artifact.attribution,
        createdAt: artifact.createdAt,
        key: artifact.key,
        kind: "spec",
        label:
          artifact.source === "form"
            ? "Feature spec"
            : `@spec ${shortSubject(artifact.text, 32)}`,
        projectPath: null,
        spec: {
          fields: artifact.fields,
          source: artifact.source,
          text: artifact.text,
          turnIndex: artifact.turnIndex,
        },
        target: null,
        turnId: artifact.turnId,
      };
    }

    default: {
      const _exhaustive: never = artifact;
      return _exhaustive;
    }
  }
}

/** Newest first, ties broken by key ascending — deterministic ordering. */
function byRecency(a: ArtifactChip, b: ArtifactChip): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * Counts over the whole input, chips capped and ordered for display.
 *
 * Counts and chips are computed independently: a diff with no files counts
 * towards `diffs` (it is a real artifact) but produces no chip (there is
 * nothing to click).
 */
export function summarizeArtifacts(
  artifacts: readonly SessionArtifact[],
): ArtifactSummary {
  let diffs = 0;
  let commits = 0;
  let prs = 0;
  let specs = 0;
  let plans = 0;

  for (const artifact of artifacts) {
    switch (artifact.kind) {
      case "diff": {
        diffs += 1;
        if (artifact.role?.name === "plan") plans += 1;
        break;
      }
      case "commit": {
        commits += 1;
        break;
      }
      case "pr": {
        prs += 1;
        break;
      }
      case "spec": {
        specs += 1;
        break;
      }
      default: {
        const _exhaustive: never = artifact;
        void _exhaustive;
      }
    }
  }

  const allChips = artifacts
    .map(chipFor)
    .filter((chip): chip is ArtifactChip => chip !== null);

  const chipsByKey: Record<string, ArtifactChip> = {};
  for (const chip of allChips) chipsByKey[chip.key] = chip;

  // The join, over the FULL artifact list — see ArtifactChip.caused's doc.
  const { specs: attributions } = attributeArtifactsToSpecs(artifacts);
  for (const { spec, produced } of attributions) {
    const chip = chipsByKey[spec.key];
    if (!chip) continue;
    const causedChips = produced
      .map(({ artifact, strength }) => {
        const producedChip = chipsByKey[artifact.key];
        if (!producedChip) return null;
        return { key: producedChip.key, kind: producedChip.kind, label: producedChip.label, strength };
      })
      .filter((row): row is ArtifactChipCaused => row !== null);
    chip.caused = causedChips.slice(0, SPEC_CAUSED_CAP);
    chip.causedOverflow = Math.max(0, causedChips.length - SPEC_CAUSED_CAP);
  }

  const chips = allChips.sort(byRecency).slice(0, CHIP_CAP);

  return { chips, chipsByKey, commits, diffs, plans, prs, specs };
}
