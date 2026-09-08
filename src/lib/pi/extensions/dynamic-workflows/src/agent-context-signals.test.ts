import { describe, expect, it } from "vitest";

import {
  createEmptyAgentContextSignals,
  recordCompactionSignal,
  recordStopReason,
} from "./agent-context-signals.ts";

describe("recordCompactionSignal", () => {
  it("counts a compaction_start and records its reason", () => {
    const signals = createEmptyAgentContextSignals();

    recordCompactionSignal(signals, { type: "compaction_start", reason: "overflow" });

    expect(signals.compactions).toBe(1);
    expect(signals.compactionReasons).toEqual(["overflow"]);
    expect(signals.events).toEqual([{ reason: "overflow" }]);
  });

  it("folds the matching compaction_end's willRetry/tokens into the same event", () => {
    const signals = createEmptyAgentContextSignals();

    recordCompactionSignal(signals, { type: "compaction_start", reason: "threshold" });
    recordCompactionSignal(signals, {
      type: "compaction_end",
      reason: "threshold",
      willRetry: false,
      result: { tokensBefore: 120000, estimatedTokensAfter: 30000 },
    });

    expect(signals.compactions).toBe(1);
    expect(signals.events).toEqual([
      {
        reason: "threshold",
        willRetry: false,
        tokensBefore: 120000,
        estimatedTokensAfter: 30000,
      },
    ]);
  });

  it("counts multiple compactions across a session in order", () => {
    const signals = createEmptyAgentContextSignals();

    recordCompactionSignal(signals, { type: "compaction_start", reason: "manual" });
    recordCompactionSignal(signals, { type: "compaction_end", reason: "manual" });
    recordCompactionSignal(signals, { type: "compaction_start", reason: "overflow" });
    recordCompactionSignal(signals, { type: "compaction_end", reason: "overflow", willRetry: true });

    expect(signals.compactions).toBe(2);
    expect(signals.compactionReasons).toEqual(["manual", "overflow"]);
    expect(signals.events[1]).toMatchObject({ reason: "overflow", willRetry: true });
  });

  it("ignores every other event type, including agent_end and message_start", () => {
    const signals = createEmptyAgentContextSignals();

    recordCompactionSignal(signals, { type: "message_start" });
    recordCompactionSignal(signals, { type: "agent_end" });

    expect(signals.compactions).toBe(0);
    expect(signals.events).toEqual([]);
  });

  it("still counts a compaction_start whose reason is outside pi's documented vocabulary", () => {
    const signals = createEmptyAgentContextSignals();

    recordCompactionSignal(signals, { type: "compaction_start", reason: "some-future-reason" });

    expect(signals.compactions).toBe(1);
    expect(signals.compactionReasons).toEqual([]);
    expect(signals.events).toEqual([{ reason: undefined }]);
  });
});

describe("recordStopReason", () => {
  it("records the stopReason when known", () => {
    const signals = createEmptyAgentContextSignals();

    recordStopReason(signals, "length");

    expect(signals.stopReason).toBe("length");
  });

  it("leaves stopReason unset when undefined is passed", () => {
    const signals = createEmptyAgentContextSignals();

    recordStopReason(signals, undefined);

    expect(signals.stopReason).toBeUndefined();
  });
});
