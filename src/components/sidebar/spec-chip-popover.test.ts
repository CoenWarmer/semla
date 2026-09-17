/**
 * SpecChipPopover itself is not rendered here — this repo has no jsdom test
 * environment — so this covers the pure helpers: the header line and the
 * strength badge's English.
 */
import { describe, expect, it } from "vitest";

import { specChipHeader, strengthLabel } from "@/components/sidebar/spec-chip-popover";
import type { ArtifactChip } from "@/lib/artifacts/artifact-summary";

const chip = (overrides: Partial<ArtifactChip> = {}): ArtifactChip => ({
  attribution: "turn",
  createdAt: "2026-01-01T00:00:00.000Z",
  key: "spec:t1:marker",
  kind: "spec",
  label: "@spec always use tabs",
  projectPath: null,
  spec: { fields: [], source: "marker", text: "always use tabs", turnIndex: 3 },
  target: null,
  turnId: "t1",
  ...overrides,
});

describe("specChipHeader", () => {
  it("names the turn ordinal for a marker spec", () => {
    expect(specChipHeader(chip())).toBe("@spec · turn 3");
  });

  it("falls back to a bare '@spec' when turnIndex is null", () => {
    expect(
      specChipHeader(chip({ spec: { fields: [], source: "marker", text: "x", turnIndex: null } })),
    ).toBe("@spec");
  });

  it("is 'Feature spec' for a form, regardless of turnIndex", () => {
    expect(
      specChipHeader(chip({ spec: { fields: [], source: "form", text: "x", turnIndex: null } })),
    ).toBe("Feature spec");
  });
});

describe("strengthLabel", () => {
  it("labels same-turn and after distinctly", () => {
    expect(strengthLabel("same-turn")).toBe("this turn");
    expect(strengthLabel("after")).toBe("after");
  });
});
