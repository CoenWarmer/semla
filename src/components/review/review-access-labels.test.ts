import { describe, expect, it } from "vitest";

import { agentLabelFor, buildAccessLabels } from "./review-access-labels";
import type { AccessHighlight } from "./review-panel-request";

const highlight = (over: Partial<AccessHighlight> = {}): AccessHighlight => ({
  agent: null,
  inferred: false,
  kind: "read",
  ranges: [{ end: 20, start: 10 }],
  tool: "read",
  via: null,
  ...over,
});

describe("buildAccessLabels", () => {
  it("anchors one label at the start of each range", () => {
    const labels = buildAccessLabels(
      highlight({
        ranges: [
          { end: 20, start: 10 },
          { end: 80, start: 60 },
        ],
      }),
      200,
    );

    expect(labels.map((label) => label.line)).toEqual([10, 60]);
    expect(labels.map((label) => label.text)).toEqual(["read", "read"]);
  });

  it("names the shell verb behind a bash access", () => {
    const [label] = buildAccessLabels(
      highlight({ inferred: true, tool: "bash", via: "sed" }),
      200,
    );

    expect(label?.text).toBe("bash – sed");
    expect(label?.inferred).toBe(true);
  });

  it("leaves a typed tool's label unqualified", () => {
    const [label] = buildAccessLabels(highlight({ tool: "edit" }), 200);

    expect(label?.text).toBe("edit");
  });

  it("appends a subagent's label but not the host agent's", () => {
    const [named] = buildAccessLabels(
      highlight({ agent: "researcher", tool: "bash", via: "rg" }),
      200,
    );
    const [host] = buildAccessLabels(highlight({ agent: null }), 200);

    expect(named?.text).toBe("bash – rg · researcher");
    expect(host?.text).toBe("read");
  });

  it("marks a whole-file access with a single label at line 1", () => {
    const labels = buildAccessLabels(highlight({ ranges: [] }), 200);

    expect(labels).toHaveLength(1);
    expect(labels[0]?.line).toBe(1);
    expect(labels[0]?.text).toBe("read · whole file");
  });

  it("clamps a range recorded against a longer file", () => {
    const [label] = buildAccessLabels(
      highlight({ ranges: [{ end: 900, start: 800 }] }),
      12,
    );

    expect(label?.line).toBe(12);
  });

  it("collapses ranges that clamp onto the same line", () => {
    const labels = buildAccessLabels(
      highlight({
        ranges: [
          { end: 900, start: 800 },
          { end: 950, start: 900 },
        ],
      }),
      12,
    );

    expect(labels).toHaveLength(1);
  });

  it("has nothing to draw without an access", () => {
    expect(buildAccessLabels(null, 200)).toEqual([]);
    expect(buildAccessLabels(highlight(), 0)).toEqual([]);
  });
});

describe("agentLabelFor", () => {
  it("omits the host agent and names every other", () => {
    expect(agentLabelFor({ id: "main", label: "Main" })).toBeNull();
    expect(agentLabelFor({ id: "run1:2", label: "reviewer" })).toBe("reviewer");
  });
});
