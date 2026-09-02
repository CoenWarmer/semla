/**
 * Two shapes reach asWorkflowSnapshot, and only one of them was handled.
 *
 * A `workflow` tool result wraps the snapshot in `details`. A snapshot read
 * straight off the manager — which is how a bridge-dispatched wiki ingest
 * reports progress — is already the snapshot. Requiring the wrapper made every
 * forwarded ingest event convert to undefined and vanish, so the run still
 * reached no debug file and no waterfall after being wired up to do both.
 */
import { describe, expect, it } from "vitest";

import { asWorkflowSnapshot } from "./session-events.ts";

const snapshot = {
  runId: "wiki-ingest-mthammjf-r0yajj",
  agents: [{ id: 1, label: "Synthesize: semla Overview", status: "running" }],
  agentCount: 1,
  doneCount: 0,
  runningCount: 1,
  errorCount: 0,
};

describe("asWorkflowSnapshot", () => {
  it("reads a snapshot taken straight from the manager", () => {
    expect(asWorkflowSnapshot(snapshot)?.runId).toBe("wiki-ingest-mthammjf-r0yajj");
  });

  it("still reads one wrapped in a tool result", () => {
    expect(asWorkflowSnapshot({ details: snapshot })?.runId).toBe(
      "wiki-ingest-mthammjf-r0yajj",
    );
  });

  it("rejects an object that carries no agents", () => {
    expect(asWorkflowSnapshot({ runId: "x" })).toBeUndefined();
    expect(asWorkflowSnapshot({ details: { runId: "x" } })).toBeUndefined();
  });

  it("rejects a non-object", () => {
    expect(asWorkflowSnapshot(null)).toBeUndefined();
    expect(asWorkflowSnapshot("snapshot")).toBeUndefined();
  });
});
