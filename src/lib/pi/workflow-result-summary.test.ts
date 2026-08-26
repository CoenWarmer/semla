import { describe, expect, it } from "vitest";

import { summarizeRunResult } from "@/lib/pi/workflow-result-summary";

const PERSIST_LOG = "Logs persisted to /home/u/.pi/workflows/runs/run-1.log";

describe("summarizeRunResult", () => {
  it("returns a string result verbatim", () => {
    expect(summarizeRunResult("all checks passed")).toBe("all checks passed");
  });

  it("prefers a human-readable field over the JSON dump", () => {
    expect(
      summarizeRunResult({ agents: 3, summary: "9 of 10 matched" }),
    ).toBe("9 of 10 matched");
  });

  it("falls back to a JSON dump when no readable field is present", () => {
    expect(summarizeRunResult({ count: 2 })).toBe('{\n  "count": 2\n}');
  });

  it("keeps an explicit null result distinct from a missing one", () => {
    expect(summarizeRunResult(null)).toBe("null");
  });

  it("explains the mistake when the script returned nothing", () => {
    const summary = summarizeRunResult(undefined);

    expect(summary).toContain("must end with an explicit `return`");
    expect(summary).not.toBe("null");
  });

  it("surfaces logged output for a returnless run", () => {
    const summary = summarizeRunResult(undefined, [
      "Summary:\n6 overlapping animals.",
      PERSIST_LOG,
    ]);

    expect(summary).toContain("Summary:\n6 overlapping animals.");
    expect(summary).toContain("rather than re-running the workflow");
    expect(summary).not.toContain(PERSIST_LOG);
  });

  it("caps a long JSON dump and points at the run file", () => {
    const summary = summarizeRunResult({ blob: "x".repeat(2500) });

    expect(summary).toHaveLength(
      2000 + "\n…(truncated — read the rest from the path below)".length,
    );
    expect(summary).toContain("read the rest from the path below");
  });

  it("caps long logged output for a returnless run", () => {
    const summary = summarizeRunResult(undefined, ["x".repeat(2500)]);

    expect(summary).toContain("read the rest from the path below");
  });
});
