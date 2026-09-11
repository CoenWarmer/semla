/**
 * Panel sizes on disk, following the same round-trip and merge contract as
 * user-settings-store.ts.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readPanelLayouts, writePanelLayouts } from "./panel-layout-store.ts";

const dir = () => mkdtempSync(join(tmpdir(), "semla-panel-layout-"));
const USER = "9b00564c-0f56-498c-a5d0-d4ebcc0f8802";

describe("panel layouts on disk", () => {
  it("has nothing for a user who has never resized anything", () => {
    expect(readPanelLayouts(USER, dir())).toBeNull();
  });

  it("round-trips a single pixel height", () => {
    const d = dir();
    writePanelLayouts(USER, { "bottom-panel-height": 420 }, d);

    expect(readPanelLayouts(USER, d)).toEqual({ "bottom-panel-height": 420 });
  });

  it("round-trips a percentage layout map", () => {
    const d = dir();
    writePanelLayouts(
      USER,
      { "review-split-horizontal": { conversation: 55, review: 45 } },
      d,
    );

    expect(readPanelLayouts(USER, d)).toEqual({
      "review-split-horizontal": { conversation: 55, review: 45 },
    });
  });

  // Each resizable group saves its own key independently; one group's drag
  // must not erase another's last-saved size.
  it("merges, so saving one panel's layout does not clear another's", () => {
    const d = dir();
    writePanelLayouts(USER, { "bottom-panel-height": 420 }, d);

    writePanelLayouts(
      USER,
      { "review-split-horizontal": { conversation: 55, review: 45 } },
      d,
    );

    expect(readPanelLayouts(USER, d)).toEqual({
      "bottom-panel-height": 420,
      "review-split-horizontal": { conversation: 55, review: 45 },
    });
  });

  it("overwrites a key it saves again", () => {
    const d = dir();
    writePanelLayouts(USER, { "bottom-panel-height": 420 }, d);
    writePanelLayouts(USER, { "bottom-panel-height": 500 }, d);

    expect(readPanelLayouts(USER, d)).toEqual({ "bottom-panel-height": 500 });
  });

  it("keeps users apart", () => {
    const d = dir();
    writePanelLayouts(USER, { "bottom-panel-height": 420 }, d);
    writePanelLayouts("other-user", { "bottom-panel-height": 999 }, d);

    expect(readPanelLayouts(USER, d)).toEqual({ "bottom-panel-height": 420 });
    expect(readPanelLayouts("other-user", d)).toEqual({
      "bottom-panel-height": 999,
    });
  });

  it("survives a corrupt record rather than throwing", () => {
    const d = dir();
    mkdirSync(join(d, "panel-layout"), { recursive: true });
    writeFileSync(join(d, "panel-layout", `${USER}.json`), "{ truncated", "utf8");

    expect(readPanelLayouts(USER, d)).toBeNull();
  });
});
