import { describe, expect, it } from "vitest";

import {
  hunkBracketHeight,
  hunkBracketLineCount,
  hunkButtonCenter,
  visibleTopLine,
  type LineGeometry,
} from "./review-hunk-bracket-geometry";

/** 100 lines of 19px, with a 200px view zone between lines 56 and 57. */
const LINE = 19;
const ZONE = 200;
const withZone: LineGeometry = {
  bottom: (line) => withZone.top(line) + LINE,
  lineCount: 100,
  top: (line) => (line - 1) * LINE + (line > 56 ? ZONE : 0),
};

describe("hunkBracketHeight", () => {
  it("includes a view zone between the span's lines", () => {
    expect(hunkBracketHeight({ endLine: 70, startLine: 37 }, 1, withZone)).toBe(
      34 * LINE + ZONE,
    );
  });

  it("excludes a view zone below the span", () => {
    expect(hunkBracketHeight({ endLine: 50, startLine: 37 }, 1, withZone)).toBe(14 * LINE);
  });

  it("measures from the clamped anchor once the start has scrolled away", () => {
    expect(hunkBracketHeight({ endLine: 70, startLine: 37 }, 60, withZone)).toBe(11 * LINE);
  });
});

describe("hunkButtonCenter", () => {
  const viewport = { bottom: 500, top: 100 };

  it("is the bracket's middle when the whole bracket is in view", () => {
    expect(hunkButtonCenter({ bottom: 300, top: 200 }, viewport, 10)).toBe(50);
  });

  it("is the viewport's middle when the bracket is taller than it", () => {
    // Middle of the viewport is 300, i.e. 300 below the bracket's top at 0.
    expect(hunkButtonCenter({ bottom: 2000, top: 0 }, viewport, 10)).toBe(300);
  });

  it("is the middle of what shows when the bracket runs off one edge", () => {
    expect(hunkButtonCenter({ bottom: 900, top: 300 }, viewport, 10)).toBe(100);
  });

  it("stays inside the bracket, and falls back to its middle off-screen", () => {
    expect(hunkButtonCenter({ bottom: 104, top: 0 }, viewport, 10)).toBe(94);
    expect(hunkButtonCenter({ bottom: 900, top: 700 }, viewport, 10)).toBe(100);
  });
});

describe("visibleTopLine", () => {
  it("is the first line any part of which is below the scroll offset", () => {
    expect(visibleTopLine(withZone, 0)).toBe(1);
    expect(visibleTopLine(withZone, LINE - 1)).toBe(1);
    expect(visibleTopLine(withZone, LINE)).toBe(2);
  });

  it("accounts for a view zone above the viewport", () => {
    // Line 57 starts at 56 * 19 + 200; a division by the line height would
    // say line 67 there.
    expect(visibleTopLine(withZone, 56 * LINE + ZONE)).toBe(57);
  });
});

describe("hunkBracketLineCount", () => {
  it("returns the full span when the hunk's start is at or below the viewport top", () => {
    const entry = { endLine: 20, startLine: 10 };
    expect(hunkBracketLineCount(entry, 1)).toBe(11);
    expect(hunkBracketLineCount(entry, 10)).toBe(11);
  });

  it("shrinks to what's left below the clamped anchor once the hunk's start has scrolled above the viewport", () => {
    const entry = { endLine: 20, startLine: 10 };
    // Monaco clamps the widget's rendered position to the viewport's own
    // top line once `startLine` scrolls above it — the bracket has to grow
    // from there, not from the original `startLine`, or it would overshoot
    // past `endLine` on screen.
    expect(hunkBracketLineCount(entry, 15)).toBe(6);
    expect(hunkBracketLineCount(entry, 20)).toBe(1);
  });

  it("never returns less than one line, even once the whole hunk has scrolled past", () => {
    const entry = { endLine: 20, startLine: 10 };
    expect(hunkBracketLineCount(entry, 25)).toBe(1);
  });

  it("is 1 for a single-line hunk regardless of scroll position", () => {
    const entry = { endLine: 10, startLine: 10 };
    expect(hunkBracketLineCount(entry, 1)).toBe(1);
    expect(hunkBracketLineCount(entry, 10)).toBe(1);
  });
});
