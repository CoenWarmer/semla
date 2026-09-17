import { describe, expect, it } from "vitest";

import { chipFor, CHIP_CAP, summarizeArtifacts } from "@/lib/artifacts/artifact-summary";
import type {
  CommitArtifact,
  DiffArtifact,
  PrArtifact,
  SessionArtifact,
  SpecArtifact,
} from "@/lib/artifacts/artifact-types";

const baseIdentity = {
  attribution: "tool-call" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
  projectPath: "semla",
  roundId: "live-round-0",
  sessionId: "session-1",
  toolCallId: "call-1",
  toolName: "edit",
  turnId: "20260101T000000000Z-aaaaaaaa",
};

function diffArtifact(overrides: Partial<DiffArtifact> = {}): DiffArtifact {
  return {
    ...baseIdentity,
    baseSha: "base",
    filesOmitted: 0,
    files: [
      {
        hunks: [
          { heading: "fn", index: 0, newLines: 3, newStart: 10, oldLines: 3, oldStart: 10 },
        ],
        hunksOmitted: false,
        oldPath: null,
        path: "src/a.ts",
        status: "modified",
      },
    ],
    headSha: "head",
    kind: "diff",
    key: "call-1:diff:0",
    patchFile: null,
    patchTruncated: false,
    role: null,
    ...overrides,
  };
}

function commitArtifact(overrides: Partial<CommitArtifact> = {}): CommitArtifact {
  return {
    ...baseIdentity,
    at: "2026-01-01T00:00:00.000Z",
    author: "agent",
    fileCount: 1,
    files: ["src/a.ts"],
    kind: "commit",
    key: "call-1:commit:sha1",
    sha: "sha1",
    shortSha: "sha1sh",
    subject: "fix foo",
    ...overrides,
  };
}

function prArtifact(overrides: Partial<PrArtifact> = {}): PrArtifact {
  return {
    ...baseIdentity,
    command: "gh pr create",
    kind: "pr",
    key: "call-1:pr:https://github.com/o/r/pull/412",
    number: 412,
    repo: "o/r",
    source: "gh-cli",
    url: "https://github.com/o/r/pull/412",
    ...overrides,
  };
}

function specArtifact(overrides: Partial<SpecArtifact> = {}): SpecArtifact {
  return {
    attribution: "turn",
    createdAt: "2026-01-01T00:00:00.000Z",
    fields: [],
    key: "spec:turn-1:marker",
    kind: "spec",
    projectPath: null,
    roundId: null,
    sessionId: "session-1",
    source: "marker",
    text: "always use tabs",
    toolCallId: null,
    toolName: null,
    turnId: "turn-1",
    turnIndex: 0,
    ...overrides,
  };
}

describe("chipFor", () => {
  it("returns null for a diff artifact with zero files", () => {
    expect(chipFor(diffArtifact({ files: [] }))).toBeNull();
  });

  it("targets files[0] and its first hunk for a diff", () => {
    const chip = chipFor(diffArtifact());
    expect(chip?.target).toEqual({
      anchor: { heading: "fn", index: 0, newLines: 3, newStart: 10, oldLines: 3, oldStart: 10 },
      commitSha: null,
      path: "src/a.ts",
      project: "semla",
    });
  });

  it("carries commitSha and a null anchor for a commit chip", () => {
    const chip = chipFor(commitArtifact());
    expect(chip?.target).toEqual({
      anchor: null,
      commitSha: "sha1",
      path: "src/a.ts",
      project: "semla",
    });
  });

  it("gives a commit with no files a null target rather than inventing a path", () => {
    const chip = chipFor(commitArtifact({ files: [] }));
    expect(chip?.target).toBeNull();
  });

  it("has a null target and a url for a pr chip", () => {
    const chip = chipFor(prArtifact());
    expect(chip?.target).toBeNull();
    expect(chip?.url).toBe("https://github.com/o/r/pull/412");
  });

  it("carries the artifact's attribution through to the chip", () => {
    // The sidebar renders a turn-attributed chip distinctly (muted, with a
    // "not attributable" title); it needs this on the chip, not the target,
    // since a pr/turn-level commit chip can have a null target.
    expect(chipFor(diffArtifact())?.attribution).toBe("tool-call");
    expect(
      chipFor(
        commitArtifact({
          attribution: "turn",
          key: "turn:2026-01-01T00:00:00.000Z:semla:commit:sha1",
          toolCallId: null,
          toolName: null,
        }),
      )?.attribution,
    ).toBe("turn");
  });

  it("labels a marker spec with its text, and a form spec generically", () => {
    expect(chipFor(specArtifact())?.label).toBe("@spec always use tabs");
    expect(
      chipFor(specArtifact({ source: "form", text: "goal text" }))?.label,
    ).toBe("Feature spec");
  });

  it("has a null projectPath and target for a spec chip, and carries the spec fields", () => {
    const chip = chipFor(specArtifact({ fields: [{ label: "Goal", value: "ship it" }] }));
    expect(chip?.projectPath).toBeNull();
    expect(chip?.target).toBeNull();
    expect(chip?.spec).toEqual({
      fields: [{ label: "Goal", value: "ship it" }],
      source: "marker",
      text: "always use tabs",
      turnIndex: 0,
    });
  });
});

describe("summarizeArtifacts", () => {
  it("counts per kind over the whole input", () => {
    const artifacts: SessionArtifact[] = [
      diffArtifact(),
      diffArtifact({ files: [], key: "k2" }),
      commitArtifact(),
      prArtifact(),
      specArtifact(),
    ];
    const summary = summarizeArtifacts(artifacts);
    expect(summary.diffs).toBe(2);
    expect(summary.commits).toBe(1);
    expect(summary.prs).toBe(1);
    expect(summary.specs).toBe(1);
    // The empty diff counted above produces no chip; the spec now does.
    expect(summary.chips.length).toBe(4);
  });

  it("builds chipsByKey over every chip produced, uncapped", () => {
    const artifacts: SessionArtifact[] = Array.from({ length: CHIP_CAP + 2 }, (_, i) =>
      commitArtifact({
        createdAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),
        key: `k${i}`,
        sha: `sha${i}`,
      }),
    );
    const summary = summarizeArtifacts(artifacts);
    expect(summary.chips).toHaveLength(CHIP_CAP);
    expect(Object.keys(summary.chipsByKey)).toHaveLength(CHIP_CAP + 2);
  });

  it("links a same-turn artifact into the spec chip's caused list", () => {
    const spec = specArtifact({ key: "spec:t1:marker", turnId: "t1" });
    const diff = diffArtifact({ key: "d1", turnId: "t1", createdAt: "2026-01-01T00:00:01.000Z" });
    const summary = summarizeArtifacts([spec, diff]);
    const specChip = summary.chips.find((c) => c.kind === "spec");
    expect(specChip?.caused).toEqual([{ key: "d1", kind: "diff", label: "1 file", strength: "same-turn" }]);
    expect(specChip?.causedOverflow).toBe(0);
  });

  it("caps caused at SPEC_CAUSED_CAP and reports the overflow count", () => {
    const spec = specArtifact({ key: "spec:t1:marker", turnId: "t1" });
    const diffs = Array.from({ length: 10 }, (_, i) =>
      diffArtifact({
        createdAt: `2026-01-01T00:00:${String(i + 1).padStart(2, "0")}.000Z`,
        key: `d${i}`,
        turnId: "t1",
      }),
    );
    const summary = summarizeArtifacts([spec, ...diffs]);
    // Not summary.chips: CHIP_CAP (6) is smaller than 1 spec + 10 diffs, and
    // the spec is the oldest artifact here, so recency ordering would push it
    // off the capped list. chipsByKey is exactly the uncapped lookup for this.
    const specChip = summary.chipsByKey["spec:t1:marker"];
    expect(specChip?.caused).toHaveLength(8);
    expect(specChip?.causedOverflow).toBe(2);
  });

  it("orders chips newest first, and caps at CHIP_CAP", () => {
    const artifacts: SessionArtifact[] = Array.from({ length: CHIP_CAP + 2 }, (_, i) =>
      commitArtifact({
        createdAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),
        key: `k${i}`,
        sha: `sha${i}`,
      }),
    );
    const summary = summarizeArtifacts(artifacts);
    expect(summary.chips).toHaveLength(CHIP_CAP);
    expect(summary.chips[0].key).toBe(`k${CHIP_CAP + 1}`);
  });

  it("breaks ties in createdAt by key ascending, deterministically", () => {
    const artifacts: SessionArtifact[] = [
      commitArtifact({ createdAt: "2026-01-01T00:00:00.000Z", key: "b", sha: "b" }),
      commitArtifact({ createdAt: "2026-01-01T00:00:00.000Z", key: "a", sha: "a" }),
    ];
    const summary = summarizeArtifacts(artifacts);
    expect(summary.chips.map((c) => c.key)).toEqual(["a", "b"]);
  });
});

describe("diff roles on chips", () => {
  it("labels a plan chip with its filename instead of a file count", () => {
    const chip = chipFor(
      diffArtifact({
        files: [
          { hunks: [], hunksOmitted: false, oldPath: null, path: "docs/plans/commit-scoped-review.md", status: "added" },
        ],
        role: { name: "plan", source: "declared" },
      }),
    );
    expect(chip?.label).toBe("commit-scoped-review");
    expect(chip?.role).toEqual({ name: "plan", source: "declared" });
  });

  it("keeps a plan chip's click target, so it still opens in the review panel", () => {
    // The whole reason a role beat a fifth ArtifactKind.
    const chip = chipFor(
      diffArtifact({
        files: [
          { hunks: [], hunksOmitted: false, oldPath: null, path: "docs/plans/a.md", status: "added" },
        ],
        role: { name: "plan", source: "inferred" },
      }),
    );
    expect(chip?.target).toEqual({
      anchor: null,
      commitSha: null,
      path: "docs/plans/a.md",
      project: "semla",
    });
  });

  it("still counts a file count for a diff with no role", () => {
    expect(chipFor(diffArtifact({ role: null }))?.label).toBe("1 file");
  });

  it("counts plans as a subset of diffs, never as a sibling", () => {
    const summary = summarizeArtifacts([
      diffArtifact({ key: "d1", role: { name: "plan", source: "declared" } }),
      diffArtifact({ key: "d2", role: null }),
    ]);
    expect(summary.diffs).toBe(2);
    expect(summary.plans).toBe(1);
  });

  it("marks an artifact with no turnId as unattributable", () => {
    // Legacy rows only: permanent, not a failure to chase.
    expect(chipFor(diffArtifact({ turnId: null }))?.unattributable).toBe(true);
    expect(chipFor(diffArtifact({ turnId: "t1" }))?.unattributable).toBe(false);
  });
});
