import { describe, expect, it } from "vitest";

import {
  buildSequence,
  clampIndex,
  indexOfFile,
  mergeRanges,
  rangeLabel,
  revealLineFor,
  stepIndex,
} from "./access-sequence.ts";
import type { FileAccess } from "./access-types.ts";

let counter = 0;

const access = (over: Partial<FileAccess> = {}): FileAccess => ({
  agent: { id: "main", label: "Main" },
  at: "2026-01-01T00:00:00.000Z",
  confidence: "exact",
  id: `a${(counter += 1)}`,
  kind: "read",
  missing: false,
  path: "src/a.ts",
  project: "semla",
  ranges: [],
  tool: "read",
  turnId: "u1",
  ...over,
});

describe("mergeRanges", () => {
  it("merges overlapping spans", () => {
    expect(
      mergeRanges([
        { end: 40, start: 10 },
        { end: 60, start: 30 },
      ]),
    ).toEqual([{ end: 60, start: 10 }]);
  });

  it("merges spans that abut, leaving no seam in the gutter", () => {
    expect(
      mergeRanges([
        { end: 40, start: 1 },
        { end: 80, start: 41 },
      ]),
    ).toEqual([{ end: 80, start: 1 }]);
  });

  it("keeps a real gap apart", () => {
    expect(
      mergeRanges([
        { end: 40, start: 1 },
        { end: 90, start: 50 },
      ]),
    ).toEqual([
      { end: 40, start: 1 },
      { end: 90, start: 50 },
    ]);
  });

  it("lets a run to end-of-file absorb what follows it", () => {
    expect(
      mergeRanges([
        { end: null, start: 10 },
        { end: 90, start: 50 },
      ]),
    ).toEqual([{ end: null, start: 10 }]);
  });

  it("sorts before merging", () => {
    expect(
      mergeRanges([
        { end: 90, start: 50 },
        { end: 60, start: 10 },
      ]),
    ).toEqual([{ end: 90, start: 10 }]);
  });
});

describe("buildSequence", () => {
  it("folds a file read in several passes into one stop", () => {
    // Four `sed -n` calls paging through a file are one thing the agent did.
    // Four stops, each re-opening it a hundred lines further down, is worse
    // than useless.
    const sequence = buildSequence([
      access({ ranges: [{ end: 100, start: 1 }] }),
      access({ ranges: [{ end: 200, start: 101 }] }),
      access({ ranges: [{ end: 300, start: 201 }] }),
    ]);

    expect(sequence.steps).toHaveLength(1);
    expect(sequence.steps[0]).toMatchObject({
      count: 3,
      ranges: [{ end: 300, start: 1 }],
    });
  });

  it("does not fold a read and a write of the same file together", () => {
    const sequence = buildSequence([
      access({ ranges: [{ end: 10, start: 1 }] }),
      access({ kind: "write", ranges: [{ end: 5, start: 5 }] }),
    ]);
    expect(sequence.steps.map((step) => step.kind)).toEqual(["read", "write"]);
  });

  it("does not fold non-consecutive visits to one file", () => {
    // Coming back to a file after looking elsewhere is a distinct moment, and
    // collapsing it would make the sequence disagree with the transcript.
    const sequence = buildSequence([
      access({ path: "src/a.ts" }),
      access({ path: "src/b.ts" }),
      access({ path: "src/a.ts" }),
    ]);
    expect(sequence.steps.map((step) => step.path)).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/a.ts",
    ]);
  });

  it("lets a whole-file read absorb the ranges folded into it", () => {
    const sequence = buildSequence([
      access({ ranges: [{ end: 100, start: 1 }] }),
      access({ ranges: [] }),
    ]);
    expect(sequence.steps[0]?.ranges).toEqual([]);
  });

  it("taints a folded stop with an inferred access", () => {
    const sequence = buildSequence([
      access({ ranges: [{ end: 10, start: 1 }] }),
      access({ confidence: "inferred", ranges: [{ end: 20, start: 11 }], tool: "bash" }),
    ]);
    expect(sequence.steps[0]?.confidence).toBe("inferred");
  });

  it("does not claim a sibling project's file is the same file", () => {
    const sequence = buildSequence([
      access({ project: "semla" }),
      access({ project: "semla-wiki" }),
    ]);
    expect(sequence.steps).toHaveLength(2);
  });

  it("counts files that are no longer on disk rather than stepping onto them", () => {
    const sequence = buildSequence([
      access({ path: "src/gone.ts", missing: true }),
      access({ path: "src/here.ts" }),
    ]);
    expect(sequence).toMatchObject({ missing: 1 });
    expect(sequence.steps.map((step) => step.path)).toEqual(["src/here.ts"]);
  });

  it("counts reads outside every linked project rather than stepping onto them", () => {
    // The file API refuses a path outside the session's projects, so an arrow
    // landing on `node_modules` would be an arrow that does nothing.
    const sequence = buildSequence([
      access({ path: "node_modules/react/index.js", project: null }),
      access({ path: "src/here.ts" }),
    ]);
    expect(sequence).toMatchObject({ unlinked: 1 });
    expect(sequence.steps.map((step) => step.path)).toEqual(["src/here.ts"]);
  });

  it("scopes to one turn", () => {
    const sequence = buildSequence(
      [access({ turnId: "u1" }), access({ path: "src/b.ts", turnId: "u2" })],
      { agentId: null, turnId: "u2" },
    );
    expect(sequence.steps.map((step) => step.path)).toEqual(["src/b.ts"]);
  });

  it("scopes to one agent", () => {
    const sequence = buildSequence(
      [
        access(),
        access({
          agent: { id: "run1:reviewer", label: "reviewer" },
          path: "src/b.ts",
        }),
      ],
      { agentId: "run1:reviewer", turnId: null },
    );
    expect(sequence.steps.map((step) => step.path)).toEqual(["src/b.ts"]);
  });

  it("does not fold two agents' reads of one file together", () => {
    // They are different agents' work even at the same path, and the pill
    // names whose it was.
    const sequence = buildSequence([
      access(),
      access({ agent: { id: "run1:reviewer", label: "reviewer" } }),
    ]);
    expect(sequence.steps).toHaveLength(2);
  });
});

describe("revealLineFor", () => {
  it("prefers a resolved symbol's own line", () => {
    const [step] = buildSequence([
      access({
        ranges: [{ end: 200, start: 100 }],
        symbol: { kind: "Function", line: 150, name: "f" },
      }),
    ]).steps;
    expect(revealLineFor(step!)).toBe(150);
  });

  it("asks for no scroll on a whole-file write", () => {
    // Leaves the editor's open-on-the-first-hunk behaviour alone, which is
    // where the interesting part of a rewritten file usually is.
    const [step] = buildSequence([access({ kind: "write", ranges: [] })]).steps;
    expect(revealLineFor(step!)).toBeNull();
  });
});

describe("rangeLabel", () => {
  const label = (ranges: FileAccess["ranges"]) =>
    rangeLabel(buildSequence([access({ ranges })]).steps[0]!);

  it("reads a span as a span and a single line as a line", () => {
    expect(label([{ end: 160, start: 120 }])).toBe("L120\u2013160");
    expect(label([{ end: 42, start: 42 }])).toBe("L42");
  });

  it("marks a run to the end of the file", () => {
    expect(label([{ end: null, start: 300 }])).toBe("L300+");
  });

  it("says nothing for a whole file", () => {
    expect(label([])).toBeNull();
  });
});

describe("index helpers", () => {
  it("clamps into an empty sequence without going negative", () => {
    expect(clampIndex(5, 0)).toBe(0);
    expect(clampIndex(-3, 4)).toBe(0);
    expect(clampIndex(9, 4)).toBe(3);
  });

  it("finds the stop for the file the panel is showing", () => {
    const { steps } = buildSequence([
      access({ path: "src/a.ts" }),
      access({ path: "src/b.ts" }),
    ]);
    expect(indexOfFile(steps, { path: "src/b.ts", project: "semla" })).toBe(1);
    expect(indexOfFile(steps, { path: "src/c.ts", project: "semla" })).toBeNull();
    expect(indexOfFile(steps, null)).toBeNull();
  });
});

describe("stepIndex", () => {
  // The bug this pins: the editor followed the agent while the counter sat on
  // whatever the arrows last touched, so "11 / 13" named a file that was not
  // on screen.
  it("pins to the newest stop while following, ignoring a stale cursor", () => {
    expect(stepIndex({ cursor: 3, following: true, length: 13 })).toBe(12);
  });

  it("tracks the sequence growing under it while a turn runs", () => {
    expect(stepIndex({ cursor: null, following: true, length: 1 })).toBe(0);
    expect(stepIndex({ cursor: null, following: true, length: 14 })).toBe(13);
  });

  it("hands control back to the cursor once following stops", () => {
    expect(stepIndex({ cursor: 3, following: false, length: 13 })).toBe(3);
  });

  // "Not started": the pill shows the first stop's number without having
  // navigated anywhere, so opening the panel does not yank the editor.
  it("shows the first stop for a cursor that has never moved", () => {
    expect(stepIndex({ cursor: null, following: false, length: 13 })).toBe(0);
  });

  // The scope toggle and the agent filter both shorten the sequence under a
  // cursor that was valid a moment ago.
  it("clamps a cursor left past the end of a shortened sequence", () => {
    expect(stepIndex({ cursor: 40, following: false, length: 13 })).toBe(12);
  });

  it("stays at zero for an empty sequence rather than going negative", () => {
    expect(stepIndex({ cursor: null, following: true, length: 0 })).toBe(0);
    expect(stepIndex({ cursor: 5, following: false, length: 0 })).toBe(0);
  });
});
