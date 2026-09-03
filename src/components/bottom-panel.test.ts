/**
 * The height is shared between the console and the agent timeline, because the
 * panel slot is. These are the three decisions in that: what a drag is allowed
 * to produce, what "expand" means, and what the expand button does the second
 * time it is pressed.
 */
import { describe, expect, it } from "vitest";

import {
  clampPanelHeight,
  DEFAULT_PANEL_HEIGHT,
  expandedPanelHeight,
  nextPanelHeight,
} from "./bottom-panel.tsx";

const VIEWPORT = 1000;

describe("clampPanelHeight", () => {
  it("keeps a height a drag asked for", () => {
    expect(clampPanelHeight(420, VIEWPORT)).toBe(420);
  });

  it("will not go below the floor", () => {
    // Dragged to nothing, the panel would be a sliver with no way back except
    // the collapse button.
    expect(clampPanelHeight(0, VIEWPORT)).toBe(96);
    expect(clampPanelHeight(-500, VIEWPORT)).toBe(96);
  });

  it("will not push the bar off the screen", () => {
    // Taller than the window puts the bar — and the handle that would undo it
    // — below the bottom edge.
    expect(clampPanelHeight(5_000, VIEWPORT)).toBe(900);
  });

  it("rounds, because a style attribute is pixels", () => {
    expect(clampPanelHeight(300.6, VIEWPORT)).toBe(301);
  });
});

describe("expandedPanelHeight", () => {
  it("is 80% of the viewport", () => {
    expect(expandedPanelHeight(VIEWPORT)).toBe(800);
    expect(expandedPanelHeight(900)).toBe(720);
  });
});

describe("nextPanelHeight", () => {
  it("expands from the default", () => {
    expect(nextPanelHeight(DEFAULT_PANEL_HEIGHT, VIEWPORT)).toBe(800);
  });

  it("collapses back when already expanded", () => {
    expect(nextPanelHeight(800, VIEWPORT)).toBe(DEFAULT_PANEL_HEIGHT);
  });

  it("still collapses a height that is expanded but not exactly", () => {
    // A drag lands on whole pixels and a viewport fraction rarely does, so an
    // equality test would leave the button doing nothing here.
    expect(nextPanelHeight(799, VIEWPORT)).toBe(DEFAULT_PANEL_HEIGHT);
    expect(nextPanelHeight(801, VIEWPORT)).toBe(DEFAULT_PANEL_HEIGHT);
  });

  it("expands from a height that was dragged somewhere else", () => {
    expect(nextPanelHeight(500, VIEWPORT)).toBe(800);
    expect(nextPanelHeight(96, VIEWPORT)).toBe(800);
  });

  it("stays on screen in a window shorter than the default panel", () => {
    // At 300px, 80% is 240 while the 288 default clamps to 270 — so
    // "expanded" is the shorter of the two. The toggle still alternates, and
    // both ends fit, which is all that matters at a size this absurd.
    expect(nextPanelHeight(240, 300)).toBe(270);
    expect(nextPanelHeight(270, 300)).toBe(240);
  });
});
