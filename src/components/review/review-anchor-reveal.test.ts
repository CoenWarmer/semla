import { describe, expect, it } from "vitest";

import type { HunkAnchor } from "@/lib/artifacts/artifact-types";
import type { Hunk } from "@/lib/review/review-types";

import {
  anchorRevealRequest,
  matchAnchor,
} from "./review-anchor-reveal.ts";
import { BLANK_REQUEST, type PanelTarget } from "./review-panel-request.ts";

const anchor = (over: Partial<HunkAnchor> = {}): HunkAnchor => ({
  heading: "function foo()",
  index: 0,
  newLines: 3,
  newStart: 10,
  oldLines: 3,
  oldStart: 10,
  ...over,
});

const hunk = (over: Partial<Hunk> = {}): Hunk => ({
  heading: "function foo()",
  index: 0,
  lines: [],
  newLines: 3,
  newStart: 10,
  oldLines: 3,
  oldStart: 10,
  ...over,
});

describe("matchAnchor", () => {
  it("matches an exact old/new range", () => {
    const target = anchor();
    const candidates = [hunk({ newStart: 40, heading: "elsewhere" }), hunk()];
    expect(matchAnchor(target, candidates)).toBe(candidates[1]);
  });

  it("falls back to the same heading, nearest newStart, when the range shifted", () => {
    const target = anchor({ newStart: 10 });
    const shifted = hunk({ heading: "function foo()", newStart: 14, newLines: 4 });
    const farther = hunk({ heading: "function foo()", newStart: 30 });
    expect(matchAnchor(target, [farther, shifted])).toBe(shifted);
  });

  it("falls back to nearest newStart overall when headings differ", () => {
    const target = anchor({ heading: "function foo()", newStart: 10 });
    const near = hunk({ heading: "function bar()", newStart: 12 });
    const far = hunk({ heading: "function baz()", newStart: 100 });
    expect(matchAnchor(target, [far, near])).toBe(near);
  });

  it("returns null for an empty hunk list", () => {
    expect(matchAnchor(anchor(), [])).toBeNull();
  });
});

const target = (over: Partial<PanelTarget> = {}): PanelTarget => ({
  nonce: 5,
  path: "src/a.ts",
  project: "semla",
  ...over,
});

describe("anchorRevealRequest", () => {
  it("returns the same object when the target has no anchor", () => {
    const request = { ...BLANK_REQUEST, reveal: { line: 1, nonce: 1 } };
    expect(anchorRevealRequest(request, target(), [hunk()])).toBe(request);
  });

  it("returns the same object when there are no hunks yet", () => {
    const request = { ...BLANK_REQUEST };
    expect(
      anchorRevealRequest(request, target({ anchor: anchor() }), undefined),
    ).toBe(request);
  });

  it("returns the same object when nothing matches", () => {
    const request = { ...BLANK_REQUEST };
    expect(
      anchorRevealRequest(request, target({ anchor: anchor() }), []),
    ).toBe(request);
  });

  it("corrects reveal.line to the matched hunk's live newStart", () => {
    const request = { ...BLANK_REQUEST, reveal: { line: 999, nonce: 1 } };
    const shifted = hunk({ newStart: 14 });
    const result = anchorRevealRequest(
      request,
      target({ anchor: anchor({ newStart: 10 }) }),
      [shifted],
    );
    expect(result.reveal).toEqual({ line: 14, nonce: 5 });
  });

  it("keeps the target's nonce, producing an unequal reveal object so Monaco re-scrolls", () => {
    const request = { ...BLANK_REQUEST, reveal: { line: 10, nonce: 1 } };
    const result = anchorRevealRequest(
      request,
      target({ anchor: anchor({ newStart: 10 }), nonce: 5 }),
      [hunk({ newStart: 10 })],
    );
    // Same line, but a different nonce means a different object.
    expect(result.reveal).toEqual({ line: 10, nonce: 5 });
    expect(result.reveal).not.toBe(request.reveal);
  });

  it("leaves selection and expanded untouched", () => {
    const selection = { path: "src/a.ts", project: "semla" };
    const request = { ...BLANK_REQUEST, expanded: selection, selection };
    const result = anchorRevealRequest(
      request,
      target({ anchor: anchor() }),
      [hunk()],
    );
    expect(result.selection).toBe(selection);
    expect(result.expanded).toBe(selection);
  });
});
