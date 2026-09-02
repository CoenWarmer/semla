import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { createSpanSink } from "@/lib/pi/telemetry/span-sink";
import type { RecordedSpan } from "@/lib/pi/telemetry/span-sink";
import { appendSpans, readSpans, spanFilePath } from "@/lib/pi/telemetry/span-store";
import { createWorkflowTelemetry } from "@/lib/pi/telemetry/workflow-recorder";

const SESSION = "00000000-0000-4000-8000-0000000005ea";

let dir: string;

beforeEach(async () => {
  // Always injected. Defaulting to PI_SESSION_DIR once wrote 201 junk
  // sessions into the real directory.
  dir = await mkdtemp(join(tmpdir(), "semla-spans-"));
});

describe("appendSpans / readSpans", () => {
  it("round-trips what the recorder produced", async () => {
    const clock = { ms: 1_000 };
    const sink = createSpanSink(SESSION, { now: () => clock.ms });
    const telemetry = createWorkflowTelemetry(sink);
    telemetry.runStarted("run-1", { background: false, name: "persisted" });
    clock.ms += 5;
    telemetry.phaseStarted("run-1", "One");

    await appendSpans(SESSION, sink.spans(), { dir });

    const read = await readSpans(SESSION, { dir });
    expect(read).toEqual(sink.spans());
  });

  it("lets a later write of the same span win", async () => {
    const clock = { ms: 1_000 };
    const sink = createSpanSink(SESSION, { now: () => clock.ms });
    const telemetry = createWorkflowTelemetry(sink);
    telemetry.runStarted("run-1", { background: false, name: "closing" });

    // Open, as the first flush would write it.
    await appendSpans(SESSION, sink.spans(), { dir });
    clock.ms += 50;
    telemetry.runEnded("run-1", { status: "completed" });
    // Closed, as the next flush writes it.
    await appendSpans(SESSION, sink.spans(), { dir });

    const read = await readSpans(SESSION, { dir });
    expect(read).toHaveLength(1);
    expect(read[0]?.endTimeMs).toBe(1_050);
    expect(read[0]?.attributes["semla.workflow.status"]).toBe("completed");
  });

  it("appends rather than rewriting", async () => {
    const sink = createSpanSink(SESSION, { now: () => 1 });
    sink.openSpan({ name: "a" });
    await appendSpans(SESSION, sink.spans(), { dir });
    const afterFirst = (await readFile(spanFilePath(SESSION, dir), "utf8")).length;

    sink.openSpan({ name: "b" });
    await appendSpans(SESSION, sink.spans(), { dir });
    const afterSecond = (await readFile(spanFilePath(SESSION, dir), "utf8")).length;

    // Rewriting the whole file per flush is O(n²) bytes for a long run, which
    // is the same reason the wire carries deltas.
    expect(afterSecond).toBeGreaterThan(afterFirst);
    expect(await readSpans(SESSION, { dir })).toHaveLength(2);
  });

  it("reads nothing for a session that recorded nothing", async () => {
    expect(await readSpans(SESSION, { dir })).toEqual([]);
  });

  it("writes nothing for an empty batch", async () => {
    await appendSpans(SESSION, [], { dir });
    expect(await readSpans(SESSION, { dir })).toEqual([]);
  });

  it("skips a truncated final line", async () => {
    const sink = createSpanSink(SESSION, { now: () => 1 });
    sink.openSpan({ name: "whole" });
    await appendSpans(SESSION, sink.spans(), { dir });
    // A reader can catch a file mid-append while a turn is running.
    await writeFile(spanFilePath(SESSION, dir), '{"spanId":"tru', { flag: "a" });

    const read = await readSpans(SESSION, { dir });
    expect(read).toHaveLength(1);
    expect(read[0]?.name).toBe("whole");
  });

  it("skips valid JSON that is not a span", async () => {
    await writeFile(spanFilePath(SESSION, dir), '{"hello":"world"}\n[]\n"x"\n');
    expect(await readSpans(SESSION, { dir })).toEqual([]);
  });

  it("returns spans in start order however they were written", async () => {
    const late: RecordedSpan = {
      attributes: {},
      endTimeMs: null,
      events: [],
      name: "late",
      parentSpanId: null,
      spanId: "l",
      startTimeMs: 900,
      status: { status: "ok" },
      traceId: "t",
    };
    await appendSpans(SESSION, [late, { ...late, name: "early", spanId: "e", startTimeMs: 100 }], { dir });

    expect((await readSpans(SESSION, { dir })).map((s) => s.name)).toEqual([
      "early",
      "late",
    ]);
  });

  it("does not throw when the directory does not exist", async () => {
    // A write that fails must not fail a turn.
    await expect(
      appendSpans(SESSION, [
        {
          attributes: {},
          endTimeMs: null,
          events: [],
          name: "n",
          parentSpanId: null,
          spanId: "s",
          startTimeMs: 0,
          status: { status: "ok" },
          traceId: "t",
        },
      ], { dir: join(dir, "nope", "deeper") }),
    ).resolves.toBeUndefined();
  });
});
