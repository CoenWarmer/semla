/**
 * The recorder has to reach the manager that actually runs.
 *
 * It did not, and nothing said so. `session_start` set telemetry and then, a
 * few lines later, replaced `manager` outright for a cross-project rebuild —
 * whose options come from `buildManagerOptions`, which knows nothing about
 * telemetry. A Semla session whose cwd is the workspace root takes that
 * branch, so the wiring looked complete, tsc was happy, every unit test
 * passed, and no span was ever recorded.
 *
 * That failure is invisible by construction: telemetry defaults to a no-op, so
 * losing it produces an empty trace rather than an error. These are the two
 * tests that would have caught it.
 */
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createSpanSink } from "@/lib/pi/telemetry/span-sink";
import { createWorkflowTelemetry } from "@/lib/pi/telemetry/workflow-recorder";
import { WorkflowManager } from "@/lib/pi/extensions/dynamic-workflows/src/workflow-manager";

// `run` is generic in its output schema, so a non-generic double cannot
// satisfy it. Same stub the manager's own test uses.
// oxlint-disable-next-line typescript/no-explicit-any
const mockAgent = { run: async () => "mock result" } as any;

describe("session_start hands telemetry to the live manager", () => {
  const source = readFileSync("src/lib/pi/extensions/workflow.ts", "utf8");

  it("sets it after the last manager rebuild, not before", () => {
    const setAt = source.indexOf("manager.setTelemetry(");
    const lastRebuild = source.lastIndexOf("manager = new WorkflowManager(");

    expect(setAt).toBeGreaterThan(-1);
    expect(lastRebuild).toBeGreaterThan(-1);
    // Before it, the recorder goes to an instance that is discarded.
    expect(setAt).toBeGreaterThan(lastRebuild);
  });

  it("looks the sink up by the pi runtime session id", () => {
    // Keyed on the Supabase row id instead, every lookup misses silently —
    // the mistake wiki-session-repo already made once. Matched on where the
    // id comes from rather than on one spelling of the call, so extracting it
    // to a variable is not a failure.
    const idFrom = /const (\w+) = ctx\.sessionManager\.getSessionId\(\)/.exec(
      source,
    );
    expect(idFrom).not.toBeNull();

    const id = idFrom?.[1] ?? "";
    expect(source).toContain(`getSpanSink(${id})`);
    // And the turn span must come from the same key, or runs nest under a
    // turn from a different session.
    expect(source).toContain(`getTurnSpanId(${id})`);
  });
});

describe("reconfigureAfterReload keeps the recorder", () => {
  it("still records a run started after the reload", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "semla-reload-"));
    await mkdir(join(cwd, ".git"), { recursive: true });

    const sink = createSpanSink("00000000-0000-4000-8000-00000000ab1e");
    const manager = new WorkflowManager({
      cwd,
      agent: mockAgent,
    });
    manager.setTelemetry(createWorkflowTelemetry(sink));

    // The other cwd branch calls this, and its docblock in workflow.ts warns
    // that it "replaces every option rather than merging" — which is exactly
    // how `toolsets` was silently unset once before. Telemetry must survive,
    // because the caller there has no recorder to pass.
    manager.reconfigureAfterReload({ loadSavedWorkflow: () => undefined });

    await manager.runSync(`
export const meta = { name: 'after-reload', description: 'd', phases: [{ title: 'One' }] };
phase('One');
await agent('a', { label: 'solo' });
return { ok: true };
`);

    // Driven through the manager, not through a fresh recorder — that is the
    // whole point: nothing re-set telemetry after the reload.
    expect(sink.spans().length).toBeGreaterThan(0);
    expect(sink.spans().map((span) => span.name)).toContain(
      "semla.workflow.run",
    );
  }, 300_000);
});
