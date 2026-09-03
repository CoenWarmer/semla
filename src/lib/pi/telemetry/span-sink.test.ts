/**
 * The sink's first duty is to be invisible. A span that was dropped, redacted,
 * or recorded against a full cap must still run its callback and still return
 * or throw exactly what it would have. Telemetry that can alter a turn is worse
 * than no telemetry, so most of what follows is about that rather than about
 * the spans.
 *
 * The rest pins the two decisions in docs/plans/agent-telemetry.md §8: sensitive
 * attributes are kept unless asked otherwise, and there is no cap by default
 * while the count is kept regardless.
 */
import { describe, expect, it, vi } from "vitest";

import {
  createSpanSink,
  sensitiveAttributeKeys,
  traceIdForSession,
} from "./span-sink.ts";
import { SEMLA_TELEMETRY_SCHEMA } from "./schema.ts";

const SESSION = "00000000-0000-4000-8000-00000000dead";

/** A clock that advances a millisecond per read, so durations are decidable. */
const tickingClock = () => {
  let t = 1_000;
  return () => ++t;
};

describe("it does not change what the program does", () => {
  it("returns the callback's value", async () => {
    const sink = createSpanSink(SESSION);

    expect(await sink.startSpan({ name: "a" }, () => 42)).toBe(42);
  });

  it("awaits an async callback", async () => {
    const sink = createSpanSink(SESSION);

    expect(
      await sink.startSpan({ name: "a" }, async () => {
        await Promise.resolve();
        return "done";
      }),
    ).toBe("done");
  });

  it("rethrows the original error object, untouched", async () => {
    const sink = createSpanSink(SESSION);
    const boom = new Error("boom");

    await expect(
      sink.startSpan({ name: "a" }, () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });

  /** The cap is the case most likely to be got wrong. */
  it("still runs the callback for a span it refuses to record", async () => {
    const sink = createSpanSink(SESSION, { maxSpans: 1 });
    const ran = vi.fn();

    await sink.startSpan({ name: "kept" }, () => {});
    expect(await sink.startSpan({ name: "dropped" }, () => {
      ran();
      return "value";
    })).toBe("value");

    expect(ran).toHaveBeenCalledOnce();
    expect(sink.spans().map((s) => s.name)).toEqual(["kept"]);
    expect(sink.counts).toMatchObject({ dropped: 1, recorded: 1 });
  });

  it("lets a dropped span's methods be called harmlessly", async () => {
    const sink = createSpanSink(SESSION, { maxSpans: 0 });

    await expect(
      sink.startSpan({ name: "a" }, (span) => {
        span.setAttributes({ x: 1 });
        span.addEvent("e", { y: 2 });
        span.setStatus({ status: "error" });
        return "ok";
      }),
    ).resolves.toBe("ok");
  });
});

describe("the trace id", () => {
  it("is derived from the session, so a reload lands on the same trace", () => {
    expect(createSpanSink(SESSION).traceId).toBe(createSpanSink(SESSION).traceId);
  });

  it("differs between sessions", () => {
    expect(traceIdForSession("a")).not.toBe(traceIdForSession("b"));
  });

  // What OTel and the waterfall's makeTraceId both expect.
  it("is 32 hex characters", () => {
    expect(traceIdForSession(SESSION)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("is on every span", async () => {
    const sink = createSpanSink(SESSION);
    await sink.startSpan({ name: "a" }, () => {});

    expect(sink.spans()[0]?.traceId).toBe(sink.traceId);
  });
});

describe("the tree", () => {
  it("parents a child to the span it was started from", async () => {
    const sink = createSpanSink(SESSION);

    await sink.startSpan({ name: "parent" }, async (parent) => {
      await parent.startSpan({ name: "child" }, async (child) => {
        await child.startSpan({ name: "grandchild" }, () => {});
      });
    });

    const [parent, child, grandchild] = sink.spans();
    expect(parent?.parentSpanId).toBeNull();
    expect(child?.parentSpanId).toBe(parent?.spanId);
    expect(grandchild?.parentSpanId).toBe(child?.spanId);
  });

  it("gives every span a distinct 16-hex id", async () => {
    const sink = createSpanSink(SESSION);
    for (const name of ["a", "b", "c"]) {
      await sink.startSpan({ name }, () => {});
    }

    const ids = sink.spans().map((s) => s.spanId);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  /**
   * Siblings, not a chain: two spans started from the sink are both roots. The
   * risk with an ambient-context design is that the second silently nests under
   * the first; there is no ambient context here, and this says so.
   */
  it("keeps two spans started from the sink as siblings", async () => {
    const sink = createSpanSink(SESSION);
    await sink.startSpan({ name: "a" }, () => {});
    await sink.startSpan({ name: "b" }, () => {});

    expect(sink.spans().map((s) => s.parentSpanId)).toEqual([null, null]);
  });

  it("records spans in start order", async () => {
    const sink = createSpanSink(SESSION);
    await sink.startSpan({ name: "outer" }, async (outer) => {
      await outer.startSpan({ name: "inner" }, () => {});
    });

    expect(sink.spans().map((s) => s.name)).toEqual(["outer", "inner"]);
  });
});

describe("timing", () => {
  it("records a start and an end", async () => {
    const sink = createSpanSink(SESSION, { now: tickingClock() });
    await sink.startSpan({ name: "a" }, () => {});

    const span = sink.spans()[0]!;
    expect(span.startTimeMs).toBe(1_001);
    expect(span.endTimeMs).toBe(1_002);
  });

  it("closes a span whose callback threw", async () => {
    const sink = createSpanSink(SESSION, { now: tickingClock() });
    await sink
      .startSpan({ name: "a" }, () => {
        throw new Error("x");
      })
      .catch(() => {});

    expect(sink.spans()[0]?.endTimeMs).not.toBeNull();
    expect(sink.counts.open).toBe(0);
  });

  // An open span is a turn still running, or one that never closed — the
  // difference matters when reading a trace, so it is visible rather than
  // implied by a null.
  it("counts a span still in flight as open", async () => {
    const sink = createSpanSink(SESSION);
    let release: (() => void) | undefined;
    const pending = sink.startSpan(
      { name: "a" },
      () => new Promise<void>((resolve) => (release = resolve)),
    );

    expect(sink.counts.open).toBe(1);
    expect(sink.spans()[0]?.endTimeMs).toBeNull();

    release?.();
    await pending;
    expect(sink.counts.open).toBe(0);
  });
});

describe("status", () => {
  it("defaults to ok", async () => {
    const sink = createSpanSink(SESSION);
    await sink.startSpan({ name: "a" }, () => {});

    expect(sink.spans()[0]?.status).toEqual({ status: "ok" });
  });

  it("records a thrown error's name and message", async () => {
    const sink = createSpanSink(SESSION);
    await sink
      .startSpan({ name: "a" }, () => {
        throw new TypeError("bad shape");
      })
      .catch(() => {});

    expect(sink.spans()[0]?.status).toEqual({
      status: "error",
      error: { message: "bad shape", name: "TypeError" },
    });
  });

  it("describes a thrown non-Error", async () => {
    const sink = createSpanSink(SESSION);
    await sink
      .startSpan({ name: "a" }, () => {
        throw "just a string";
      })
      .catch(() => {});

    expect(sink.spans()[0]?.status).toMatchObject({
      status: "error",
      error: { message: "just a string" },
    });
  });

  /** An explicit status is the caller's judgement and outranks the throw. */
  it("keeps a status the callback set", async () => {
    const sink = createSpanSink(SESSION);
    await sink
      .startSpan({ name: "a" }, (span) => {
        span.setStatus({ status: "error", error: { message: "mine", name: "Mine" } });
        throw new Error("also this");
      })
      .catch(() => {});

    expect(sink.spans()[0]?.status).toMatchObject({
      error: { name: "Mine" },
    });
  });
});

describe("attributes and events", () => {
  it("keeps start attributes and merges later ones", async () => {
    const sink = createSpanSink(SESSION);
    await sink.startSpan({ name: "a", attributes: { start: 1 } }, (span) => {
      span.setAttributes({ end: 2 });
    });

    expect(sink.spans()[0]?.attributes).toEqual({ end: 2, start: 1 });
  });

  it("timestamps events", async () => {
    const sink = createSpanSink(SESSION, { now: tickingClock() });
    await sink.startSpan({ name: "a" }, (span) => {
      span.addEvent("first", { n: 1 });
      span.addEvent("second");
    });

    expect(sink.spans()[0]?.events).toEqual([
      { attributes: { n: 1 }, name: "first", timeMs: 1_002 },
      { attributes: {}, name: "second", timeMs: 1_003 },
    ]);
  });

  it("hands out snapshots a caller cannot mutate into the record", async () => {
    const sink = createSpanSink(SESSION);
    await sink.startSpan({ name: "a" }, (span) => span.addEvent("e"));

    sink.spans()[0]!.events = [];
    expect(sink.spans()[0]?.events).toHaveLength(1);
  });
});

/**
 * §8.1: kept for now, and dropping is a switch rather than a rewrite. Which
 * attributes are sensitive is read from the schema, so pi marking a new one in
 * a release is respected without a change here.
 */
describe("sensitive attributes", () => {
  const sensitiveKeys = sensitiveAttributeKeys([SEMLA_TELEMETRY_SCHEMA]);

  it("finds what the schema marks", () => {
    expect(sensitiveKeys).toContain(
      "semla.workflow.agent/semla.workflow.agent.prompt",
    );
  });

  it("marks nothing else in Semla's own schema", () => {
    expect(sensitiveKeys.size).toBe(1);
  });

  it("keeps them by default", async () => {
    const sink = createSpanSink(SESSION, { sensitiveKeys });
    await sink.startSpan(
      {
        name: "semla.workflow.agent",
        attributes: { "semla.workflow.agent.prompt": "secret" },
      },
      () => {},
    );

    expect(sink.spans()[0]?.attributes).toEqual({
      "semla.workflow.agent.prompt": "secret",
    });
  });

  it("drops them when asked, keeping the rest", async () => {
    const sink = createSpanSink(SESSION, {
      sensitive: "drop",
      sensitiveKeys,
    });
    await sink.startSpan(
      {
        name: "semla.workflow.agent",
        attributes: {
          "semla.workflow.agent.label": "review",
          "semla.workflow.agent.prompt": "secret",
        },
      },
      () => {},
    );

    expect(sink.spans()[0]?.attributes).toEqual({
      "semla.workflow.agent.label": "review",
    });
  });

  it("drops them from setAttributes too, not just the start", async () => {
    const sink = createSpanSink(SESSION, { sensitive: "drop", sensitiveKeys });
    await sink.startSpan({ name: "semla.workflow.agent" }, (span) => {
      span.setAttributes({ "semla.workflow.agent.prompt": "secret" });
    });

    expect(sink.spans()[0]?.attributes).toEqual({});
  });

  it("only drops it on the span that declares it", async () => {
    const sink = createSpanSink(SESSION, { sensitive: "drop", sensitiveKeys });
    await sink.startSpan(
      {
        name: "semla.workflow.run",
        attributes: { "semla.workflow.agent.prompt": "not sensitive here" },
      },
      () => {},
    );

    expect(sink.spans()[0]?.attributes).toEqual({
      "semla.workflow.agent.prompt": "not sensitive here",
    });
  });
});

/** §8.3: no cap by default, and the count is kept either way. */
describe("the cap", () => {
  it("is off by default", async () => {
    const sink = createSpanSink(SESSION);
    for (let i = 0; i < 500; i++) {
      await sink.startSpan({ name: `s${i}` }, () => {});
    }

    expect(sink.spans()).toHaveLength(500);
    expect(sink.counts).toMatchObject({ dropped: 0, recorded: 500 });
  });

  it("counts what it recorded even with no cap", async () => {
    const sink = createSpanSink(SESSION);
    await sink.startSpan({ name: "a" }, async (span) => {
      await span.startSpan({ name: "b" }, () => {});
    });

    expect(sink.counts.recorded).toBe(2);
  });

  it("keeps children of a dropped span parented by id", async () => {
    const sink = createSpanSink(SESSION, { maxSpans: 1 });

    await sink.startSpan({ name: "root" }, async (root) => {
      // Dropped, but its own child still records a parent — the id exists
      // whether or not the span was kept.
      await root.startSpan({ name: "dropped" }, async (dropped) => {
        await dropped.startSpan({ name: "grandchild" }, () => {});
      });
    });

    expect(sink.spans().map((s) => s.name)).toEqual(["root"]);
    expect(sink.counts).toMatchObject({ dropped: 2, recorded: 1 });
  });
});

describe("span ids across turns", () => {
  const SESSION = "00000000-0000-4000-8000-00000000c0de";

  it("are disjoint between two sinks for the same session", () => {
    // One sink per turn. Derived from the session id and a counter alone, a
    // session's second turn minted the same ids as its first, and everything
    // downstream folds by id — so the earlier turn was silently overwritten
    // in the persisted trace and in the panel.
    const first = createSpanSink(SESSION, { now: () => 1 });
    const second = createSpanSink(SESSION, { now: () => 2 });

    first.openSpan({ name: "pi.harness.turn" });
    first.openSpan({ name: "pi.harness.tool" });
    second.openSpan({ name: "pi.harness.turn" });
    second.openSpan({ name: "pi.harness.tool" });

    const ids = [...first.spans(), ...second.spans()].map((s) => s.spanId);
    expect(new Set(ids).size).toBe(4);
  });

  it("still put both turns in the same trace", () => {
    const first = createSpanSink(SESSION);
    const second = createSpanSink(SESSION);

    // The stable half: one session is one trace, across turns and reloads.
    expect(second.traceId).toBe(first.traceId);
  });

  it("are unique within a sink", () => {
    const sink = createSpanSink(SESSION);
    for (let i = 0; i < 200; i += 1) sink.openSpan({ name: "n" });

    expect(new Set(sink.spans().map((s) => s.spanId)).size).toBe(200);
  });

  it("are 16 hex characters, as OTel wants", () => {
    const sink = createSpanSink(SESSION);
    sink.openSpan({ name: "n" });

    expect(sink.spans()[0]?.spanId).toMatch(/^[0-9a-f]{16}$/);
  });
});
