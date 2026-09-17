/**
 * SessionArtifactChips itself is not rendered here — this repo has no jsdom
 * test environment — so this covers the pure logic that decides what it
 * would show: whether the row appears at all, how chips split between
 * "visible" and "+N overflow", and how a turn-attributed chip is flagged.
 * VISIBLE_ARTIFACT_CHIPS is the plan's own knob and is asserted against
 * directly so a change to it is a visible, deliberate edit here too.
 */
import { describe, expect, it } from "vitest";

import {
  chipDisplay,
  hasArtifactsToShow,
  splitArtifactChips,
  VISIBLE_ARTIFACT_CHIPS,
} from "@/components/sidebar/session-artifacts";
import type { ArtifactChip, ArtifactSummary } from "@/lib/artifacts/artifact-summary";

const chip = (overrides: Partial<ArtifactChip> = {}): ArtifactChip => ({
  attribution: "tool-call",
  createdAt: "2026-01-01T00:00:00.000Z",
  key: "k",
  kind: "diff",
  label: "1 file",
  projectPath: "semla",
  target: { anchor: null, commitSha: null, path: "src/a.ts", project: "semla" },
  ...overrides,
});

const summary = (chips: ArtifactChip[], counts: Partial<ArtifactSummary> = {}): ArtifactSummary => ({
  chips,
  chipsByKey: Object.fromEntries(chips.map((c) => [c.key, c])),
  commits: 0,
  diffs: 0,
  plans: 0,
  prs: 0,
  specs: 0,
  ...counts,
});

describe("hasArtifactsToShow", () => {
  it("is false when every count is zero", () => {
    expect(hasArtifactsToShow(summary([]))).toBe(false);
  });

  it("is true when any one kind is non-zero, even with no chips", () => {
    // A diff with zero files counts but yields no chip (see chipFor) — the
    // row still needs to show the count.
    expect(hasArtifactsToShow(summary([], { diffs: 1 }))).toBe(true);
  });

  it("is true for specs alone", () => {
    expect(hasArtifactsToShow(summary([], { specs: 1 }))).toBe(true);
  });
});

describe("splitArtifactChips", () => {
  it("keeps everything visible under the cap", () => {
    const chips = [chip({ key: "a" }), chip({ key: "b" })];
    expect(splitArtifactChips(summary(chips))).toEqual({
      overflow: [],
      visible: chips,
    });
  });

  it("splits at VISIBLE_ARTIFACT_CHIPS, preserving order", () => {
    const chips = Array.from({ length: VISIBLE_ARTIFACT_CHIPS + 2 }, (_, i) =>
      chip({ key: `k${i}` }),
    );
    const { visible, overflow } = splitArtifactChips(summary(chips));
    expect(visible).toHaveLength(VISIBLE_ARTIFACT_CHIPS);
    expect(overflow).toHaveLength(2);
    expect(visible.map((c) => c.key)).toEqual(chips.slice(0, VISIBLE_ARTIFACT_CHIPS).map((c) => c.key));
  });
});

describe("chipDisplay", () => {
  it("is not muted for a tool-call chip, and titles it with the project path", () => {
    expect(chipDisplay(chip({ attribution: "tool-call", projectPath: "semla" }))).toEqual({
      muted: false,
      title: "semla",
    });
  });

  it("is muted for a turn-attributed chip, with a title naming the ambiguity", () => {
    // The plan is explicit that this must stay visible rather than be
    // laundered into a normal-looking chip.
    expect(chipDisplay(chip({ attribution: "turn" }))).toEqual({
      muted: true,
      title: "Not attributable to a single tool call",
    });
  });

  it("is never muted for a spec chip, and titles it with the requirement text — not 'undefined'", () => {
    expect(
      chipDisplay(
        chip({
          attribution: "turn",
          kind: "spec",
          projectPath: null,
          spec: { fields: [], source: "marker", text: "always use tabs", turnIndex: 0 },
          target: null,
        }),
      ),
    ).toEqual({ muted: false, title: "always use tabs" });
  });
});

describe("chipDisplay role and attribution notes", () => {
  const diffChip = (over: Partial<ArtifactChip> = {}): ArtifactChip => ({
    attribution: "tool-call",
    createdAt: "2026-01-01T00:00:00.000Z",
    key: "k1",
    kind: "diff",
    label: "1 file",
    projectPath: "semla",
    target: null,
    ...over,
  });

  it("says a declared role was declared", () => {
    const { title } = chipDisplay(diffChip({ role: { name: "plan", source: "declared" } }));
    expect(title).toContain("Declared as a plan");
    expect(title).not.toContain("guessed");
  });

  it("says an inferred role was guessed, so it never reads as a fact", () => {
    const { title } = chipDisplay(diffChip({ role: { name: "plan", source: "inferred" } }));
    expect(title).toContain("guessed from its path");
  });

  it("explains an unattributable artifact instead of leaving it mysterious", () => {
    const { title } = chipDisplay(diffChip({ unattributable: true }));
    expect(title).toContain("cannot be linked to a requirement");
  });

  it("lists every uncertainty rather than collapsing them", () => {
    const { title, muted } = chipDisplay(
      diffChip({
        attribution: "turn",
        role: { name: "plan", source: "inferred" },
        unattributable: true,
      }),
    );
    expect(muted).toBe(true);
    expect(title).toContain("Not attributable to a single tool call");
    expect(title).toContain("cannot be linked to a requirement");
    expect(title).toContain("guessed from its path");
  });

  it("shows just the project path for an ordinary diff", () => {
    expect(chipDisplay(diffChip()).title).toBe("semla");
  });
});
