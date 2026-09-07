import { describe, expect, it } from "vitest";

import { hunkBracketLineCount } from "./review-hunk-bracket-geometry";

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
