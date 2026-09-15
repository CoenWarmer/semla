import { describe, expect, it } from "vitest";

import {
  buildSequence,
  clampIndex,
  indexOfFile,
  mergeRanges,
  linesOutside,
  rangeLabel,
  revealLineFor,
  siblingsOf,
  stepIndex,
  type ScrubberStop,
} from "./access-sequence.ts";
import type { FileAccess, ToolCallStep } from "./access-types.ts";

let counter = 0;

const access = (over: Partial<FileAccess> = {}): FileAccess => ({
  agent: { id: "main", label: "Main" },
  at: "2026-01-01T00:00:00.000Z",
  callId: "unused",
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

/** A tool call carrying whichever accesses the test cares about. */
const call = (
  accesses: FileAccess[],
  over: Partial<ToolCallStep> = {},
): ToolCallStep => ({
  accesses,
  agent: { id: "main", label: "Main" },
  at: "2026-01-01T00:00:00.000Z",
  id: `c${(counter += 1)}`,
  isError: false,
  name: "read",
  turnId: "u1",
  ...over,
});

const fileStop = (stop: ScrubberStop | undefined) => {
  if (!stop || stop.kind !== "file") throw new Error("expected a file stop");
  return stop;
};

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
  it("gives one call's several accesses their own contiguous stops", () => {
    // One `bash` reading two files is one tool call; each file it touched
    // still gets its own badge/stop, in the order the command implies.
    const sequence = buildSequence([
      call([access({ path: "src/a.ts" }), access({ path: "src/b.ts" })]),
    ]);

    expect(sequence.stops.map((stop) => fileStop(stop).access.path)).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
    expect(sequence.stops.every((stop) => stop.call.id === sequence.stops[0]?.call.id)).toBe(
      true,
    );
  });

  it("does not fold repeat reads of one file across separate tool calls", () => {
    // Four `sed -n` calls paging through a file are four tool calls now, not
    // one folded stop — a step is a call, and folding across calls is gone.
    const sequence = buildSequence([
      call([access({ ranges: [{ end: 100, start: 1 }] })]),
      call([access({ ranges: [{ end: 200, start: 101 }] })]),
      call([access({ ranges: [{ end: 300, start: 201 }] })]),
    ]);

    expect(sequence.stops).toHaveLength(3);
    expect(sequence.stops.map((stop) => stop.call.id)).toEqual([
      sequence.stops[0]?.call.id,
      sequence.stops[1]?.call.id,
      sequence.stops[2]?.call.id,
    ]);
    // Three different calls: no two stops share a call id.
    expect(new Set(sequence.stops.map((stop) => stop.call.id)).size).toBe(3);
  });

  it("does not dedup two accesses in the same call to the same file", () => {
    // A single bash command reading the same file twice, at different ranges,
    // is rare enough not to special-case — it stays two stops.
    const sequence = buildSequence([
      call([
        access({ ranges: [{ end: 10, start: 1 }] }),
        access({ ranges: [{ end: 20, start: 11 }] }),
      ]),
    ]);
    expect(sequence.stops).toHaveLength(2);
  });

  it("counts a missing access rather than stepping onto it", () => {
    const sequence = buildSequence([
      call([access({ missing: true, path: "src/gone.ts" })]),
      call([access({ path: "src/here.ts" })]),
    ]);
    expect(sequence).toMatchObject({ missing: 1 });
    expect(sequence.stops.map((stop) => fileStop(stop).access.path)).toEqual([
      "src/here.ts",
    ]);
  });

  it("counts an access outside every linked project rather than stepping onto it", () => {
    // The file API refuses a path outside the session's projects, so an arrow
    // landing on `node_modules` would be an arrow that does nothing.
    const sequence = buildSequence([
      call([access({ path: "node_modules/react/index.js", project: null })]),
      call([access({ path: "src/here.ts" })]),
    ]);
    expect(sequence).toMatchObject({ unlinked: 1 });
    expect(sequence.stops.map((stop) => fileStop(stop).access.path)).toEqual([
      "src/here.ts",
    ]);
  });

  it("excludes a call that touched no file by default", () => {
    const sequence = buildSequence([
      call([], { name: "ask_user" }),
      call([access({ path: "src/here.ts" })]),
    ]);
    expect(sequence.stops.map((stop) => stop.kind)).toEqual(["file"]);
  });

  it("includes a call that touched no file as a single stop under 'All tools'", () => {
    const sequence = buildSequence(
      [call([], { name: "ask_user" }), call([access({ path: "src/here.ts" })])],
      { agentId: null, showAllTools: true, turnId: null },
    );
    expect(sequence.stops.map((stop) => stop.kind)).toEqual(["tool", "file"]);
    expect(sequence.stops[0]).toMatchObject({ kind: "tool" });
  });

  it("scopes to one turn", () => {
    const sequence = buildSequence(
      [
        call([access({ turnId: "u1" })], { turnId: "u1" }),
        call([access({ path: "src/b.ts", turnId: "u2" })], { turnId: "u2" }),
      ],
      { agentId: null, showAllTools: false, turnId: "u2" },
    );
    expect(sequence.stops.map((stop) => fileStop(stop).access.path)).toEqual([
      "src/b.ts",
    ]);
  });

  it("scopes to one agent", () => {
    const sequence = buildSequence(
      [
        call([access()]),
        call([access({ path: "src/b.ts" })], {
          agent: { id: "run1:reviewer", label: "reviewer" },
        }),
      ],
      { agentId: "run1:reviewer", showAllTools: false, turnId: null },
    );
    expect(sequence.stops.map((stop) => fileStop(stop).access.path)).toEqual([
      "src/b.ts",
    ]);
  });

  it("does not fold two agents' reads of one file together", () => {
    // They are different agents' work even at the same path and the same
    // moment, and each keeps its own call and its own stop.
    const sequence = buildSequence([
      call([access()]),
      call([access()], { agent: { id: "run1:reviewer", label: "reviewer" } }),
    ]);
    expect(sequence.stops).toHaveLength(2);
  });
});

describe("revealLineFor", () => {
  it("prefers a resolved symbol's own line", () => {
    const [stop] = buildSequence([
      call([
        access({
          ranges: [{ end: 200, start: 100 }],
          symbol: { kind: "Function", line: 150, name: "f" },
        }),
      ]),
    ]).stops;
    expect(revealLineFor(stop!)).toBe(150);
  });

  it("asks for no scroll on a whole-file write", () => {
    // Leaves the editor's open-on-the-first-hunk behaviour alone, which is
    // where the interesting part of a rewritten file usually is.
    const [stop] = buildSequence([call([access({ kind: "write", ranges: [] })])]).stops;
    expect(revealLineFor(stop!)).toBeNull();
  });

  it("asks for no scroll on a bare tool stop", () => {
    const [stop] = buildSequence([call([], { name: "ask_user" })], {
      agentId: null,
      showAllTools: true,
      turnId: null,
    }).stops;
    expect(revealLineFor(stop!)).toBeNull();
  });
});

describe("rangeLabel", () => {
  const label = (ranges: FileAccess["ranges"]) =>
    rangeLabel(buildSequence([call([access({ ranges })])]).stops[0]!);

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

  it("says nothing for a bare tool stop", () => {
    const [stop] = buildSequence([call([], { name: "ask_user" })], {
      agentId: null,
      showAllTools: true,
      turnId: null,
    }).stops;
    expect(rangeLabel(stop!)).toBeNull();
  });
});

describe("index helpers", () => {
  it("clamps into an empty sequence without going negative", () => {
    expect(clampIndex(5, 0)).toBe(0);
    expect(clampIndex(-3, 4)).toBe(0);
    expect(clampIndex(9, 4)).toBe(3);
  });

  it("finds the stop for the file the panel is showing", () => {
    const { stops } = buildSequence([
      call([access({ path: "src/a.ts" })]),
      call([access({ path: "src/b.ts" })]),
    ]);
    expect(indexOfFile(stops, { path: "src/b.ts", project: "semla" })).toBe(1);
    expect(indexOfFile(stops, { path: "src/c.ts", project: "semla" })).toBeNull();
    expect(indexOfFile(stops, null)).toBeNull();
  });
});

describe("siblingsOf", () => {
  it("groups a call's several file stops together", () => {
    const { stops } = buildSequence([
      call([access({ path: "src/a.ts" }), access({ path: "src/b.ts" })]),
      call([access({ path: "src/c.ts" })]),
    ]);
    expect(siblingsOf(stops, 0)).toEqual({ end: 1, start: 0 });
    expect(siblingsOf(stops, 1)).toEqual({ end: 1, start: 0 });
    expect(siblingsOf(stops, 2)).toEqual({ end: 2, start: 2 });
  });

  it("returns an empty range for an out-of-bounds index", () => {
    const { stops } = buildSequence([call([access()])]);
    expect(siblingsOf(stops, 5)).toEqual({ end: -1, start: -1 });
    expect(siblingsOf(stops, -1)).toEqual({ end: -1, start: -1 });
  });
});

describe("linesOutside", () => {
  it("returns the gap either side of a read", () => {
    expect(linesOutside([{ end: 20, start: 10 }], 100)).toEqual([
      { end: 9, start: 1 },
      { end: 100, start: 21 },
    ]);
  });

  it("returns the gaps between several reads", () => {
    expect(
      linesOutside(
        [
          { end: 20, start: 10 },
          { end: 60, start: 50 },
        ],
        100,
      ),
    ).toEqual([
      { end: 9, start: 1 },
      { end: 49, start: 21 },
      { end: 100, start: 61 },
    ]);
  });

  it("treats a range running to EOF as covering everything after it", () => {
    expect(linesOutside([{ end: null, start: 50 }], 100)).toEqual([
      { end: 49, start: 1 },
    ]);
  });

  it("leaves nothing outside a read of the whole file", () => {
    expect(linesOutside([{ end: null, start: 1 }], 100)).toEqual([]);
    expect(linesOutside([{ end: 100, start: 1 }], 100)).toEqual([]);
  });

  // The file shrank since the read — an `end` past EOF must not produce a
  // range Monaco would throw on.
  it("clamps a range that runs past the end of the file as it is now", () => {
    expect(linesOutside([{ end: 500, start: 1 }], 100)).toEqual([]);
    expect(linesOutside([{ end: 500, start: 90 }], 100)).toEqual([
      { end: 89, start: 1 },
    ]);
  });

  it("merges overlapping reads before taking the gaps", () => {
    expect(
      linesOutside(
        [
          { end: 40, start: 10 },
          { end: 60, start: 30 },
        ],
        100,
      ),
    ).toEqual([
      { end: 9, start: 1 },
      { end: 100, start: 61 },
    ]);
  });

  // Opposite of the FileAccess convention, and the reason the caller has to
  // check for a whole-file access before asking.
  it("treats no ranges as covering nothing", () => {
    expect(linesOutside([], 100)).toEqual([{ end: 100, start: 1 }]);
  });

  it("has nothing to dim in an empty file", () => {
    expect(linesOutside([{ end: 10, start: 1 }], 0)).toEqual([]);
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
