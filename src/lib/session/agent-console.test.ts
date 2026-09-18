import { describe, expect, it } from "vitest";

import type { SessionToolCall } from "@/hooks/use-session-messages";
import {
  agentConsoleFromToolCalls,
  applyAgentConsoleEvent,
  mergeAgentConsole,
  MAX_CONSOLE_ENTRIES,
  MAX_ENTRY_OUTPUT_CHARS,
  stripAnsi,
  type AgentConsoleEntry,
} from "@/lib/session/agent-console";

const started = (toolCallId: string, command = "ls", at = "2026-01-01T00:00:00.000Z") =>
  applyAgentConsoleEvent([], {
    at,
    command,
    toolCallId,
    type: "bash-start",
  });

describe("applyAgentConsoleEvent", () => {
  it("opens an entry on start", () => {
    expect(started("a", "echo hi")).toEqual([
      {
        command: "echo hi",
        output: "",
        startedAt: "2026-01-01T00:00:00.000Z",
        toolCallId: "a",
      },
    ]);
  });

  it("ignores a repeated start for the same call", () => {
    const once = started("a");
    const twice = applyAgentConsoleEvent(once, {
      at: "2026-01-01T00:00:01.000Z",
      command: "ls",
      toolCallId: "a",
      type: "bash-start",
    });
    expect(twice).toEqual(once);
  });

  it("replaces output rather than appending, because updates are cumulative", () => {
    let entries = started("a");
    entries = applyAgentConsoleEvent(entries, {
      output: "one\n",
      toolCallId: "a",
      type: "bash-output",
    });
    entries = applyAgentConsoleEvent(entries, {
      output: "one\ntwo\n",
      toolCallId: "a",
      type: "bash-output",
    });
    expect(entries[0]?.output).toBe("one\ntwo\n");
  });

  it("closes an entry with its exit state", () => {
    let entries = started("a");
    entries = applyAgentConsoleEvent(entries, {
      output: "boom",
      toolCallId: "a",
      type: "bash-output",
    });
    entries = applyAgentConsoleEvent(entries, {
      at: "2026-01-01T00:00:02.000Z",
      isError: true,
      output: "trimmed",
      toolCallId: "a",
      type: "bash-end",
    });
    // Streamed output is kept in preference to the end event's trimmed copy.
    expect(entries[0]).toMatchObject({
      endedAt: "2026-01-01T00:00:02.000Z",
      isError: true,
      output: "boom",
    });
  });

  it("falls back to the end event's output when nothing streamed", () => {
    const entries = applyAgentConsoleEvent(started("a"), {
      at: "2026-01-01T00:00:02.000Z",
      isError: false,
      output: "only copy",
      toolCallId: "a",
      type: "bash-end",
    });
    expect(entries[0]?.output).toBe("only copy");
  });

  it("drops output for a call it never saw start", () => {
    expect(
      applyAgentConsoleEvent([], {
        output: "orphan",
        toolCallId: "missing",
        type: "bash-output",
      }),
    ).toEqual([]);
  });

  it("keeps only the most recent entries", () => {
    let entries: AgentConsoleEntry[] = [];
    for (let i = 0; i < MAX_CONSOLE_ENTRIES + 5; i += 1) {
      entries = applyAgentConsoleEvent(entries, {
        at: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
        command: `cmd-${i}`,
        toolCallId: `call-${i}`,
        type: "bash-start",
      });
    }
    expect(entries).toHaveLength(MAX_CONSOLE_ENTRIES);
    expect(entries[0]?.command).toBe("cmd-5");
  });

  it("keeps the tail of very long output", () => {
    const long = "x".repeat(MAX_ENTRY_OUTPUT_CHARS) + "END";
    const entries = applyAgentConsoleEvent(started("a"), {
      output: long,
      toolCallId: "a",
      type: "bash-output",
    });
    expect(entries[0]?.output).toHaveLength(MAX_ENTRY_OUTPUT_CHARS);
    expect(entries[0]?.output.endsWith("END")).toBe(true);
  });
});

describe("agentConsoleFromToolCalls", () => {
  const call = (overrides: Partial<SessionToolCall>): SessionToolCall => ({
    createdAt: "2026-01-01T00:00:00.000Z",
    id: "a",
    messageId: "m",
    name: "bash",
    params: { command: "ls" },
    ...overrides,
  });

  it("reads command and output off persisted bash rows", () => {
    expect(
      agentConsoleFromToolCalls([
        call({ isError: false, resultAt: "2026-01-01T00:00:01.000Z", resultText: "a\nb" }),
      ]),
    ).toEqual([
      {
        command: "ls",
        endedAt: "2026-01-01T00:00:01.000Z",
        isError: false,
        output: "a\nb",
        startedAt: "2026-01-01T00:00:00.000Z",
        toolCallId: "a",
      },
    ]);
  });

  it("prefers the error text for a failed call", () => {
    const entries = agentConsoleFromToolCalls([
      call({ errorText: "no such file", isError: true, resultText: "" }),
    ]);
    expect(entries[0]?.output).toBe("no such file");
  });

  it("ignores rows that are not bash, and bash rows with no command", () => {
    expect(
      agentConsoleFromToolCalls([
        call({ id: "read", name: "read", params: { path: "x" } }),
        call({ id: "nocmd", params: {} }),
      ]),
    ).toEqual([]);
  });

  it("sorts by start time", () => {
    const entries = agentConsoleFromToolCalls([
      call({ createdAt: "2026-01-01T00:00:05.000Z", id: "late" }),
      call({ createdAt: "2026-01-01T00:00:01.000Z", id: "early" }),
    ]);
    expect(entries.map((entry) => entry.toolCallId)).toEqual(["early", "late"]);
  });
});

describe("mergeAgentConsole", () => {
  const entry = (
    toolCallId: string,
    startedAt: string,
    output: string,
  ): AgentConsoleEntry => ({ command: "ls", output, startedAt, toolCallId });

  it("prefers the live copy, which keeps more output", () => {
    const merged = mergeAgentConsole(
      [entry("a", "2026-01-01T00:00:00.000Z", "trimmed")],
      [entry("a", "2026-01-01T00:00:00.000Z", "full output")],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.output).toBe("full output");
  });

  it("keeps persisted entries the live log does not have, in start order", () => {
    const merged = mergeAgentConsole(
      [entry("old", "2026-01-01T00:00:00.000Z", "x")],
      [entry("new", "2026-01-01T00:00:09.000Z", "y")],
    );
    expect(merged.map((e) => e.toolCallId)).toEqual(["old", "new"]);
  });
});

describe("stripAnsi", () => {
  it("removes colour sequences and leaves the text", () => {
    expect(stripAnsi("\u001b[31mred\u001b[0m plain")).toBe("red plain");
  });

  it("leaves output with no sequences untouched", () => {
    expect(stripAnsi("plain\noutput")).toBe("plain\noutput");
  });
});
