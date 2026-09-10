import { describe, expect, it } from "vitest";

import {
  activeRequest,
  BLANK_REQUEST,
  nextReveal,
  requestForTarget,
  type PanelRequest,
  type PanelTarget,
} from "./review-panel-request.ts";

const target = (over: Partial<PanelTarget> = {}): PanelTarget => ({
  nonce: 1,
  path: "src/a.ts",
  project: "semla",
  ...over,
});

const own = (over: Partial<PanelRequest> = {}): PanelRequest => ({
  ...BLANK_REQUEST,
  selection: { path: "src/own.ts", project: "semla" },
  ...over,
});

describe("requestForTarget", () => {
  it("opens the file and folds its hunks open", () => {
    const request = requestForTarget(target({ line: 12 }));
    expect(request).toMatchObject({
      expanded: { path: "src/a.ts", project: "semla" },
      reveal: { line: 12, nonce: 1 },
      selection: { path: "src/a.ts", project: "semla" },
    });
  });

  it("asks for no reveal when the target names no line", () => {
    // "Open this file" and "open this file at line 1" are different requests:
    // a reveal of line 1 overrides the editor's open-on-the-first-hunk
    // behaviour, which is the useful place to land in a file under review.
    expect(requestForTarget(target())?.reveal).toBeNull();
  });

  it("gives two picks of the same line two distinct reveals", () => {
    const first = requestForTarget(target({ line: 12, nonce: 1 }));
    const second = requestForTarget(target({ line: 12, nonce: 2 }));
    expect(first?.reveal).not.toEqual(second?.reveal);
  });

  it("is null when there is no target", () => {
    expect(requestForTarget(null)).toBeNull();
  });
});

describe("activeRequest", () => {
  it("prefers the panel's own request while the target is unchanged", () => {
    const mine = own({ overNonce: 1 });
    expect(activeRequest(mine, target({ nonce: 1 }))).toBe(mine);
  });

  it("lets a newer target override the panel's own navigation", () => {
    // The whole point of `overNonce`: nothing has to clear the panel's state
    // when a new pick arrives, so no effect syncs a prop into state.
    const mine = own({ overNonce: 1 });
    expect(activeRequest(mine, target({ nonce: 2 }))?.selection).toEqual({
      path: "src/a.ts",
      project: "semla",
    });
  });

  it("keeps the panel's own request when there is no target at all", () => {
    const mine = own({ overNonce: 0 });
    expect(activeRequest(mine, null)).toBe(mine);
  });

  it("falls back to a blank request with neither", () => {
    expect(activeRequest(null, null)).toBe(BLANK_REQUEST);
  });

  it("does not resurrect a request made before the only target", () => {
    // A request stamped 0 was made before any target existed; a target has
    // since arrived and is the more recent instruction.
    expect(activeRequest(own({ overNonce: 0 }), target({ nonce: 3 })).selection)
      .toEqual({ path: "src/a.ts", project: "semla" });
  });
});

describe("nextReveal", () => {
  it("makes asking for the same line twice two requests", () => {
    const first = nextReveal(BLANK_REQUEST, 40);
    const second = nextReveal({ ...BLANK_REQUEST, reveal: first }, 40);
    expect(second).toEqual({ line: 40, nonce: first.nonce + 1 });
  });
});
