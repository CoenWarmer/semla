import { describe, expect, it } from "vitest";

import {
  artifactGroups,
  chipRowLabel,
  groupHeading,
  groupKindOf,
} from "@/lib/artifacts/artifact-groups";
import type { ArtifactChip, ArtifactSummary } from "@/lib/artifacts/artifact-summary";

const chip = (over: Partial<ArtifactChip> & Pick<ArtifactChip, "key" | "kind">): ArtifactChip => ({
  attribution: "tool-call",
  createdAt: "2026-09-18T10:00:00Z",
  label: "1 file",
  projectPath: "semla",
  target: {
    anchor: null,
    commitSha: null,
    path: "src/foo.ts",
    project: "semla",
  },
  ...over,
});

const summaryOf = (chips: ArtifactChip[]): ArtifactSummary => ({
  chips,
  chipsByKey: Object.fromEntries(chips.map((entry) => [entry.key, entry])),
  commits: 0,
  diffs: 0,
  plans: 0,
  prs: 0,
  specs: 0,
});

describe("groupKindOf", () => {
  it("routes a plan-role diff to the plan group", () => {
    expect(
      groupKindOf(chip({ key: "a", kind: "diff", role: { name: "plan", source: "declared" } })),
    ).toBe("plan");
  });

  it("leaves a diff with no role as a diff", () => {
    // `plan` is currently the only DiffRoleName, so "a diff with some other
    // role" is unrepresentable rather than untested — the null case is the
    // whole of the alternative.
    expect(groupKindOf(chip({ key: "a", kind: "diff" }))).toBe("diff");
    expect(groupKindOf(chip({ key: "a", kind: "diff", role: null }))).toBe("diff");
  });

  it("passes the other kinds through", () => {
    expect(groupKindOf(chip({ key: "a", kind: "commit" }))).toBe("commit");
    expect(groupKindOf(chip({ key: "a", kind: "pr" }))).toBe("pr");
    expect(groupKindOf(chip({ key: "a", kind: "spec" }))).toBe("spec");
  });
});

describe("artifactGroups", () => {
  it("puts a plan in its own group and NOT also in diffs", () => {
    // The bug this prevents: ArtifactSummary counts a plan in `plans` AND in
    // `diffs` (a plan is a diff), so a naive per-kind split would render the
    // same file twice — once under Plans, once under Uncommitted diffs.
    const groups = artifactGroups(
      summaryOf([
        chip({
          key: "plan-1",
          kind: "diff",
          label: "session-summary-card",
          role: { name: "plan", source: "inferred" },
        }),
        chip({ key: "diff-1", kind: "diff" }),
      ]),
    );

    expect(groups.map((group) => group.kind)).toEqual(["plan", "diff"]);
    expect(groups[0].chips.map((entry) => entry.key)).toEqual(["plan-1"]);
    expect(groups[1].chips.map((entry) => entry.key)).toEqual(["diff-1"]);
  });

  it("orders groups requirement first, outcomes last", () => {
    const groups = artifactGroups(
      summaryOf([
        chip({ key: "pr-1", kind: "pr" }),
        chip({ key: "commit-1", kind: "commit" }),
        chip({ key: "diff-1", kind: "diff" }),
        chip({ key: "spec-1", kind: "spec" }),
        chip({ key: "plan-1", kind: "diff", role: { name: "plan", source: "declared" } }),
      ]),
    );
    expect(groups.map((group) => group.kind)).toEqual([
      "spec",
      "plan",
      "diff",
      "commit",
      "pr",
    ]);
  });

  it("omits a kind that produced nothing rather than showing it at zero", () => {
    const groups = artifactGroups(summaryOf([chip({ key: "diff-1", kind: "diff" })]));
    expect(groups.map((group) => group.kind)).toEqual(["diff"]);
  });

  it("reads chipsByKey, so it is not capped at CHIP_CAP", () => {
    // `chips` is capped for the sidebar's crowded row; a list wants all of
    // them. Twelve diffs is the case the operator was looking at.
    const many = Array.from({ length: 12 }, (_, index) =>
      chip({
        createdAt: `2026-09-18T10:${String(index).padStart(2, "0")}:00Z`,
        key: `diff-${index}`,
        kind: "diff",
      }),
    );
    const summary = summaryOf(many);
    // Simulate the real shape: `chips` truncated, `chipsByKey` complete.
    summary.chips = many.slice(0, 6);

    expect(artifactGroups(summary)[0].chips).toHaveLength(12);
  });

  it("orders each group newest first", () => {
    const groups = artifactGroups(
      summaryOf([
        chip({ createdAt: "2026-09-18T10:00:00Z", key: "old", kind: "commit" }),
        chip({ createdAt: "2026-09-18T12:00:00Z", key: "new", kind: "commit" }),
      ]),
    );
    expect(groups[0].chips.map((entry) => entry.key)).toEqual(["new", "old"]);
  });

  it("is empty for a session with no artifacts, and for a missing summary", () => {
    expect(artifactGroups(summaryOf([]))).toEqual([]);
    expect(artifactGroups(null)).toEqual([]);
    expect(artifactGroups(undefined)).toEqual([]);
  });
});

describe("groupHeading", () => {
  it("pluralises against the number it can actually link to", () => {
    expect(
      groupHeading({ chips: [chip({ key: "a", kind: "diff" })], kind: "diff", label: "uncommitted diff" }),
    ).toBe("1 uncommitted diff");
    expect(
      groupHeading({
        chips: [chip({ key: "a", kind: "diff" }), chip({ key: "b", kind: "diff" })],
        kind: "diff",
        label: "uncommitted diff",
      }),
    ).toBe("2 uncommitted diffs");
  });

  it("pluralises PR as PRs", () => {
    expect(
      groupHeading({
        chips: [chip({ key: "a", kind: "pr" }), chip({ key: "b", kind: "pr" })],
        kind: "pr",
        label: "PR",
      }),
    ).toBe("2 PRs");
  });
});

describe("chipRowLabel", () => {
  it("shows a diff's path, not its file count", () => {
    // "1 file" says nothing about which file on a row whose purpose is to
    // open one.
    expect(
      chipRowLabel(
        chip({
          key: "a",
          kind: "diff",
          label: "1 file",
          target: { anchor: null, commitSha: null, path: "src/lib/foo.ts", project: "semla" },
        }),
      ),
    ).toBe("src/lib/foo.ts");
  });

  it("keeps a plan's own name", () => {
    expect(
      chipRowLabel(
        chip({
          key: "a",
          kind: "diff",
          label: "session-summary-card",
          role: { name: "plan", source: "inferred" },
        }),
      ),
    ).toBe("session-summary-card");
  });

  it("keeps a commit's sha and subject, and a pr's number", () => {
    expect(chipRowLabel(chip({ key: "a", kind: "commit", label: "a1b2c3d fix foo" }))).toBe(
      "a1b2c3d fix foo",
    );
    expect(chipRowLabel(chip({ key: "a", kind: "pr", label: "#412" }))).toBe("#412");
  });

  it("falls back to the label for a diff with no target", () => {
    expect(chipRowLabel(chip({ key: "a", kind: "diff", label: "3 files", target: null }))).toBe(
      "3 files",
    );
  });
});
