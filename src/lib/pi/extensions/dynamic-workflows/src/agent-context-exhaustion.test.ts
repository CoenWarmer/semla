/**
 * §6 of docs/plans/subagent-context-pressure.md: a subagent that ran out of
 * context must not be recorded as a successful one. These tests cover the
 * pure detection (isContextExhausted) and the throwing wrapper
 * (throwIfContextExhausted) that lives next to throwIfProviderLimit — both
 * exported from agent.ts, not agent-context-signals.ts, because they read
 * AgentContextSignals rather than produce it.
 */
import { describe, expect, it } from "vitest";

import { createEmptyAgentContextSignals } from "./agent-context-signals.ts";
import { isContextExhausted, throwIfContextExhausted } from "./agent.ts";
import { isWorkflowError, WorkflowErrorCode } from "./errors.ts";

describe("isContextExhausted", () => {
  it("is false for a session with no signals at all", () => {
    expect(isContextExhausted(createEmptyAgentContextSignals())).toBe(false);
  });

  it("is false for an ordinary successful compaction (no errorMessage)", () => {
    const signals = createEmptyAgentContextSignals();
    signals.compactions = 1;
    signals.compactionReasons = ["threshold"];
    signals.events = [
      { reason: "threshold", willRetry: false, tokensBefore: 120000 },
    ];
    signals.stopReason = "stop";

    expect(isContextExhausted(signals)).toBe(false);
  });

  it("is true when the terminal stopReason is length", () => {
    const signals = createEmptyAgentContextSignals();
    signals.stopReason = "length";

    expect(isContextExhausted(signals)).toBe(true);
  });

  it("is true when an overflow compaction_end carries an errorMessage", () => {
    const signals = createEmptyAgentContextSignals();
    signals.compactions = 1;
    signals.compactionReasons = ["overflow"];
    signals.events = [
      {
        reason: "overflow",
        willRetry: false,
        errorMessage:
          "Context overflow recovery failed after one compact-and-retry attempt.",
      },
    ];
    signals.stopReason = "error";

    expect(isContextExhausted(signals)).toBe(true);
  });

  it("is false when a non-overflow compaction happens to carry an errorMessage", () => {
    // Guards the "overflow" gate specifically — a failed manual/threshold
    // compaction is a different condition, not covered by this detector.
    const signals = createEmptyAgentContextSignals();
    signals.compactions = 1;
    signals.compactionReasons = ["manual"];
    signals.events = [
      { reason: "manual", willRetry: false, errorMessage: "Auto-compaction failed: boom" },
    ];

    expect(isContextExhausted(signals)).toBe(false);
  });
});

describe("throwIfContextExhausted", () => {
  it("does nothing when signals show no exhaustion", () => {
    expect(() =>
      throwIfContextExhausted(createEmptyAgentContextSignals(), "agent 1"),
    ).not.toThrow();
  });

  it("throws a nonrecoverable AGENT_CONTEXT_EXHAUSTED when stopReason is length", () => {
    const signals = createEmptyAgentContextSignals();
    signals.stopReason = "length";

    try {
      throwIfContextExhausted(signals, "researcher");
      expect.unreachable();
    } catch (error) {
      expect(isWorkflowError(error)).toBe(true);
      if (!isWorkflowError(error)) throw error;
      expect(error.code).toBe(WorkflowErrorCode.AGENT_CONTEXT_EXHAUSTED);
      expect(error.recoverable).toBe(false);
      expect(error.agentLabel).toBe("researcher");
    }
  });

  it("throws when overflow recovery failed even if stopReason isn't length", () => {
    const signals = createEmptyAgentContextSignals();
    signals.stopReason = "error";
    signals.events = [
      { reason: "overflow", errorMessage: "Context overflow recovery failed: boom" },
    ];

    expect(() => throwIfContextExhausted(signals)).toThrowError(
      /ran out of context/,
    );
  });
});
