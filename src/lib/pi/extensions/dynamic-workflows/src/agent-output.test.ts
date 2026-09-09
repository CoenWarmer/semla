/**
 * Pins the invariants agent-output.ts's docblocks call load-bearing:
 * extractValidated never fabricates a value the schema rejects,
 * throwIfProviderLimit is gated on stopReason === "error" (not on the text
 * alone) to avoid misclassifying a clean turn that merely mentions "rate
 * limit", usageFromStats returns undefined only for genuinely all-zero
 * stats, finalAssistantText treats text before the final tool result as
 * stale (#111) while lastAssistantText stays lenient, and
 * resolveStructuredOutput's repair path surfaces a provider limit instead of
 * a misleading SCHEMA_NONCOMPLIANCE.
 */
import { describe, expect, it } from "vitest";
import { Type } from "typebox";

import type { StructuredSession } from "./agent-types.ts";
import { WorkflowErrorCode, isWorkflowError } from "./errors.ts";
import type { StructuredOutputCapture } from "./structured-output.ts";
import {
  extractValidated,
  finalAssistantText,
  lastAssistantError,
  lastAssistantText,
  resolveStructuredOutput,
  throwIfProviderLimit,
  usageFromStats,
} from "./agent-output.ts";

const schema = Type.Object({
  name: Type.String(),
  count: Type.Number(),
});

describe("extractValidated", () => {
  it("accepts a fenced ```json block", () => {
    const text = 'Here you go:\n```json\n{"name": "a", "count": 1}\n```\nThanks.';
    expect(extractValidated(text, schema)).toEqual({ name: "a", count: 1 });
  });

  it("accepts a bare balanced object surrounded by prose", () => {
    const text = 'Sure, the result is {"name": "b", "count": 2} — done.';
    expect(extractValidated(text, schema)).toEqual({ name: "b", count: 2 });
  });

  it("handles nested braces inside the balanced object", () => {
    const nestedSchema = Type.Object({
      name: Type.String(),
      meta: Type.Object({ nested: Type.Boolean() }),
    });
    const text = 'result: {"name": "c", "meta": {"nested": true}} end';
    expect(extractValidated(text, nestedSchema)).toEqual({
      name: "c",
      meta: { nested: true },
    });
  });

  it("returns undefined on malformed JSON", () => {
    const text = '```json\n{"name": "a", "count": \n```';
    expect(extractValidated(text, schema)).toBeUndefined();
  });

  it("never fabricates a value: returns undefined when JSON parses but fails the schema", () => {
    const text = '```json\n{"name": "a"}\n```'; // missing required "count"
    expect(extractValidated(text, schema)).toBeUndefined();
  });

  it("coerces a numeric string for a number field via Convert", () => {
    const text = '```json\n{"name": "a", "count": "3"}\n```';
    expect(extractValidated(text, schema)).toEqual({ name: "a", count: 3 });
  });
});

describe("lastAssistantError", () => {
  it("reads the last assistant message, skipping later non-assistant messages", () => {
    const messages = [
      { role: "assistant", stopReason: "stop" },
      { role: "assistant", stopReason: "error", errorMessage: "boom" },
      { role: "toolResult", content: [] },
      { role: "user", content: [] },
    ];
    expect(lastAssistantError(messages)).toEqual({
      stopReason: "error",
      errorMessage: "boom",
    });
  });

  it("returns undefined when there is no assistant message", () => {
    const messages = [
      { role: "user", content: [] },
      { role: "toolResult", content: [] },
    ];
    expect(lastAssistantError(messages)).toBeUndefined();
  });
});

describe("throwIfProviderLimit", () => {
  it("throws PROVIDER_USAGE_LIMIT with recoverable:false when stopReason is error and the message matches a provider limit", () => {
    const messages = [
      {
        role: "assistant",
        stopReason: "error",
        errorMessage: "Usage limit reached (plus plan). Resets in ~3h.",
      },
    ];
    try {
      throwIfProviderLimit(messages, "researcher");
      expect.unreachable();
    } catch (error) {
      expect(isWorkflowError(error)).toBe(true);
      if (!isWorkflowError(error)) throw error;
      expect(error.code).toBe(WorkflowErrorCode.PROVIDER_USAGE_LIMIT);
      expect(error.recoverable).toBe(false);
      expect(error.agentLabel).toBe("researcher");
    }
  });

  it("does not throw when stopReason is not error, even if the text mentions rate limit", () => {
    const messages = [
      {
        role: "assistant",
        stopReason: "stop",
        errorMessage: undefined,
        content: [{ type: "text", text: "Watch out for rate limit issues." }],
      },
    ];
    expect(() => throwIfProviderLimit(messages)).not.toThrow();
  });

  it("does not throw on a clean turn", () => {
    const messages = [{ role: "assistant", stopReason: "stop" }];
    expect(() => throwIfProviderLimit(messages)).not.toThrow();
  });
});

describe("usageFromStats", () => {
  it("returns undefined for all-zero stats", () => {
    expect(
      usageFromStats({
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: 0,
      }),
    ).toBeUndefined();
  });

  it("returns a full breakdown when cost > 0 but tokens are 0", () => {
    expect(
      usageFromStats({
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: 0.02,
      }),
    ).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0.02 });
  });

  it("returns a full breakdown when tokens > 0 but cost is 0", () => {
    expect(
      usageFromStats({
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
        cost: 0,
      }),
    ).toEqual({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, cost: 0 });
  });
});

describe("lastAssistantText vs finalAssistantText", () => {
  it("finalAssistantText returns empty when the last assistant text comes before the final toolResult (#111 stale progress)", () => {
    const messages = [
      { role: "assistant", content: [{ type: "text", text: "Working on it..." }] },
      { role: "toolResult", content: [] },
    ];
    expect(finalAssistantText(messages)).toBe("");
  });

  it("lastAssistantText returns that same stale text", () => {
    const messages = [
      { role: "assistant", content: [{ type: "text", text: "Working on it..." }] },
      { role: "toolResult", content: [] },
    ];
    expect(lastAssistantText(messages)).toBe("Working on it...");
  });

  it("finalAssistantText returns the answer after the final toolResult", () => {
    const messages = [
      { role: "assistant", content: [{ type: "text", text: "Working on it..." }] },
      { role: "toolResult", content: [] },
      { role: "assistant", content: [{ type: "text", text: "Final answer." }] },
    ];
    expect(finalAssistantText(messages)).toBe("Final answer.");
    expect(lastAssistantText(messages)).toBe("Final answer.");
  });

  it("both skip assistant messages whose content is only whitespace", () => {
    const messages = [
      { role: "assistant", content: [{ type: "text", text: "Real answer." }] },
      { role: "assistant", content: [{ type: "text", text: "   \n  " }] },
    ];
    expect(lastAssistantText(messages)).toBe("Real answer.");
    expect(finalAssistantText(messages)).toBe("Real answer.");
  });

  it("both concatenate multiple text parts within one assistant message", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Part one. " },
          { type: "text", text: "Part two." },
        ],
      },
    ];
    expect(lastAssistantText(messages)).toBe("Part one. Part two.");
    expect(finalAssistantText(messages)).toBe("Part one. Part two.");
  });
});

function makeSession(messages: unknown[] = []): StructuredSession {
  return {
    messages,
    prompt: async () => {},
    setActiveToolsByName: () => {},
  };
}

function noopLastText(): string {
  return "";
}

describe("resolveStructuredOutput", () => {
  it("returns the captured value when the tool was already called", async () => {
    const capture: StructuredOutputCapture<{ name: string; count: number }> = {
      called: true,
      value: { name: "a", count: 1 },
    };
    const result = await resolveStructuredOutput(
      makeSession(),
      capture,
      schema,
      {},
      noopLastText,
    );
    expect(result).toEqual({ name: "a", count: 1 });
  });

  it("re-prompts up to maxSchemaRetries and succeeds if capture flips mid-way", async () => {
    const capture: StructuredOutputCapture<{ name: string; count: number }> = {
      called: false,
      value: undefined,
    };
    let promptCalls = 0;
    const session: StructuredSession = {
      messages: [],
      prompt: async () => {
        promptCalls++;
        if (promptCalls === 2) {
          capture.called = true;
          capture.value = { name: "flip", count: 9 };
        }
      },
      setActiveToolsByName: () => {},
    };

    const result = await resolveStructuredOutput(
      session,
      capture,
      schema,
      { maxSchemaRetries: 3 },
      noopLastText,
    );

    expect(result).toEqual({ name: "flip", count: 9 });
    expect(promptCalls).toBe(2);
  });

  it("falls back to prose extraction when repair attempts never flip capture", async () => {
    const capture: StructuredOutputCapture<{ name: string; count: number }> = {
      called: false,
      value: undefined,
    };
    const session = makeSession([{ role: "assistant" }]);

    const result = await resolveStructuredOutput(
      session,
      capture,
      schema,
      { maxSchemaRetries: 1 },
      () => '```json\n{"name": "prose", "count": 5}\n```',
    );

    expect(result).toEqual({ name: "prose", count: 5 });
  });

  it("throws SCHEMA_NONCOMPLIANCE when nothing works", async () => {
    const capture: StructuredOutputCapture<{ name: string; count: number }> = {
      called: false,
      value: undefined,
    };
    const session = makeSession([{ role: "assistant", stopReason: "stop" }]);

    await expect(
      resolveStructuredOutput(
        session,
        capture,
        schema,
        { maxSchemaRetries: 1, label: "worker" },
        noopLastText,
      ),
    ).rejects.toSatisfy((error: unknown) => {
      if (!isWorkflowError(error)) return false;
      return (
        error.code === WorkflowErrorCode.SCHEMA_NONCOMPLIANCE &&
        error.recoverable === false &&
        error.agentLabel === "worker"
      );
    });
  });

  it("surfaces a PROVIDER_USAGE_LIMIT thrown by a repair turn instead of SCHEMA_NONCOMPLIANCE", async () => {
    const capture: StructuredOutputCapture<{ name: string; count: number }> = {
      called: false,
      value: undefined,
    };
    // The repair prompt itself hits the provider limit; the session records it
    // as a terminal assistant message the way the pi SDK does (never throws it
    // directly — see agent-output.ts's lastAssistantError docblock).
    const session: StructuredSession = {
      messages: [
        {
          role: "assistant",
          stopReason: "error",
          errorMessage: "Usage limit reached. Resets in ~2h.",
        },
      ],
      prompt: async () => {},
      setActiveToolsByName: () => {},
    };

    await expect(
      resolveStructuredOutput(
        session,
        capture,
        schema,
        { maxSchemaRetries: 1, label: "worker" },
        noopLastText,
      ),
    ).rejects.toSatisfy((error: unknown) => {
      if (!isWorkflowError(error)) return false;
      return error.code === WorkflowErrorCode.PROVIDER_USAGE_LIMIT;
    });
  });
});
