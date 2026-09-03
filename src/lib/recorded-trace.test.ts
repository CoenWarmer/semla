/**
 * The whole tree, assembled the way a turn assembles it.
 *
 * Every piece is unit-tested on its own, and that is exactly how step 6's
 * predecessor shipped broken: the recorder worked, the sink worked, and the
 * wiring handed the recorder to a manager that was thrown away. This drives
 * the real WorkflowManager, the real host recorder and the real mapper, and
 * asserts the shape a reader actually sees.
 */
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createHostTelemetry } from "@/lib/pi/telemetry/host-recorder";
import { createSpanSink } from "@/lib/pi/telemetry/span-sink";
import { createWorkflowTelemetry } from "@/lib/pi/telemetry/workflow-recorder";
import { WorkflowManager } from "@/lib/pi/extensions/dynamic-workflows/src/workflow-manager";
import { coversHostSession, recordedSpansToOtelSpans } from "@/lib/recorded-spans";

// oxlint-disable-next-line typescript/no-explicit-any
const mockAgent = { run: async () => "mock result" } as any;

const SCRIPT = `
export const meta = { name: 'triage', description: 'd', phases: [{ title: 'Look' }] };
phase('Look');
await parallel([() => agent('a', { label: 'scan' }), () => agent('b', { label: 'grep' })]);
return { ok: true };
`;

const buildTrace = async () => {
  const cwd = await mkdtemp(join(tmpdir(), "semla-trace-"));
  await mkdir(join(cwd, ".git"), { recursive: true });

  const sink = createSpanSink("00000000-0000-4000-8000-00000000cafe");
  const host = createHostTelemetry(sink, { piSessionId: "pi-runtime-1" });

  // The order a turn does it in: the turn span opens before extensions load,
  // because the workflow extension reads its id on session_start.
  host.turnStarted();

  const manager = new WorkflowManager({ cwd, agent: mockAgent });
  manager.setTelemetry(createWorkflowTelemetry(sink), host.turnSpanId);

  // session_start does this *after* setTelemetry, to point subagents at the
  // session's wiki toolset. Included because leaving it out is exactly why an
  // earlier version of this test passed while every run in a real session was
  // recorded at the root: `reconfigureAfterReload` replaces options wholesale,
  // and the parent link went with them.
  manager.reconfigureAfterReload({ loadSavedWorkflow: () => undefined });

  host.toolStarted("call-1", { name: "workflow" });
  await manager.runSync(SCRIPT);
  host.toolEnded("call-1", { isError: false });

  host.turnEnded("completed");

  return { host, sink };
};

describe("a turn that ran a workflow", () => {
  it("nests the whole run under the turn", async () => {
    const { host, sink } = await buildTrace();

    const byId = new Map(sink.spans().map((span) => [span.spanId, span]));
    const ancestors = (spanId: string): string[] => {
      const names: string[] = [];
      let current = byId.get(spanId);
      while (current) {
        names.push(current.name);
        current = current.parentSpanId
          ? byId.get(current.parentSpanId)
          : undefined;
      }
      return names;
    };

    const agent = sink
      .spans()
      .find((span) => span.attributes["semla.workflow.agent.label"] === "scan");
    expect(agent).toBeDefined();

    // §8.4: one trace tells the whole causal story.
    expect(ancestors(agent!.spanId)).toEqual([
      "semla.workflow.agent",
      "semla.workflow.phase",
      "semla.workflow.run",
      "pi.harness.turn",
      "pi.harness.run",
    ]);
    expect(
      sink.spans().find((s) => s.name === "semla.workflow.run")?.parentSpanId,
    ).toBe(host.turnSpanId);
  });

  it("leaves nothing open", async () => {
    const { sink } = await buildTrace();
    expect(sink.counts.open).toBe(0);
    expect(sink.counts.dropped).toBe(0);
  });

  it("now covers the host, which flips the panel's default", async () => {
    const { sink } = await buildTrace();
    // Before layer 2a this was false for every trace, so the panel always
    // defaulted to the derived timeline.
    expect(coversHostSession(sink.spans())).toBe(true);
  });

  it("maps to one rooted tree with readable labels", async () => {
    const { buildSpanTree, flattenTree } = await import(
      "react-otel-trace-waterfall"
    );
    const { sink } = await buildTrace();

    const mapped = recordedSpansToOtelSpans(sink.spans());
    const roots = buildSpanTree([...mapped]);
    const rows = flattenTree(roots, new Set(mapped.map((s) => s.spanId)));

    expect(roots).toHaveLength(1);
    // Nothing dropped: every recorded span reaches a row.
    expect(rows).toHaveLength(mapped.length);
    // No row shows a schema identifier.
    expect(mapped.every((span) => !span.name.startsWith("pi."))).toBe(true);
    expect(mapped.every((span) => !span.name.startsWith("semla."))).toBe(true);
    expect(mapped.map((span) => span.name)).toEqual(
      expect.arrayContaining(["Prompt", "Turn", "⚙ workflow", "triage", "Look", "scan"]),
    );
  });
});
