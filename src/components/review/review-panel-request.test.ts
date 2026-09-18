import { describe, expect, it } from "vitest";

import {
  activeRequest,
  baseRequestFor,
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

describe("baseRequestFor", () => {
  /** What `followRequest` looks like: overNonce -1, so nothing supersedes it. */
  const follow = (): PanelRequest => ({
    ...BLANK_REQUEST,
    overNonce: -1,
    selection: { path: "src/agent-touched.ts", project: "semla" },
  });

  it("follows the agent when nothing external asked for a file", () => {
    const request = baseRequestFor({
      chosen: BLANK_REQUEST,
      follow: follow(),
      target: null,
    });
    expect(request.selection).toEqual({ path: "src/agent-touched.ts", project: "semla" });
  });

  it("lets a fresh target beat follow, so a click is not discarded", () => {
    // The regression: `followRequest ?? chosenRequest` opened the panel on the
    // agent's last-touched file and silently threw the click away, which read
    // as "the panel opens but not on what I clicked".
    const clicked = target({ nonce: 7, path: "src/clicked.ts" });
    const request = baseRequestFor({
      chosen: requestForTarget(clicked)!,
      follow: follow(),
      target: clicked,
    });
    expect(request.selection).toEqual({ path: "src/clicked.ts", project: "semla" });
  });

  it("keeps yielding to the operator's own move made against that target", () => {
    // `activeRequest` returns the panel's own request while it carries the
    // target's nonce; follow must not reclaim the editor underneath it.
    const clicked = target({ nonce: 7 });
    const moved = own({ overNonce: 7, selection: { path: "src/moved-to.ts", project: "semla" } });
    const request = baseRequestFor({
      chosen: activeRequest(moved, clicked),
      follow: follow(),
      target: clicked,
    });
    expect(request.selection).toEqual({ path: "src/moved-to.ts", project: "semla" });
  });

  it("still honours the target when the panel's own request predates it", () => {
    // A request made BEFORE the current target is stale, so `activeRequest`
    // discards it and `chosen` becomes the target's own request — which still
    // answers to the target's nonce, so the target keeps winning. Named for
    // what it asserts: this is NOT a case where follow resumes.
    const clicked = target({ nonce: 7 });
    const stale = own({ overNonce: 2 });
    const chosen = activeRequest(stale, clicked);
    const request = baseRequestFor({ chosen, follow: follow(), target: clicked });
    expect(chosen.overNonce).toBe(7);
    expect(request.selection).toEqual({ path: "src/a.ts", project: "semla" });
  });

  it("holds follow off for as long as the clicked target is live", () => {
    // The documented cost of this rule, asserted rather than left implicit:
    // while a target is set, a NEW agent write does not pull the editor away.
    // `ClientSessionComponent` clears the target on close, which is what
    // restores following. See baseRequestFor's docblock.
    const clicked = target({ nonce: 7, path: "src/clicked.ts" });
    const request = baseRequestFor({
      chosen: requestForTarget(clicked)!,
      follow: follow(),
      target: clicked,
    });
    expect(request.selection).toEqual({ path: "src/clicked.ts", project: "semla" });
  });

  it("returns the chosen request untouched when follow is off", () => {
    const chosen = own();
    expect(baseRequestFor({ chosen, follow: null, target: null })).toBe(chosen);
  });

  it("ignores a target the chosen request no longer answers to", () => {
    // Defensive: if chosen's nonce and the target's have diverged, the target
    // is not what is being shown, so it must not hold follow off.
    const request = baseRequestFor({
      chosen: own({ overNonce: 3 }),
      follow: follow(),
      target: target({ nonce: 9 }),
    });
    expect(request.selection).toEqual({ path: "src/agent-touched.ts", project: "semla" });
  });
});

describe("nextReveal", () => {
  it("makes asking for the same line twice two requests", () => {
    const first = nextReveal(BLANK_REQUEST, 40);
    const second = nextReveal({ ...BLANK_REQUEST, reveal: first }, 40);
    expect(second).toEqual({ line: 40, nonce: first.nonce + 1 });
  });
});
