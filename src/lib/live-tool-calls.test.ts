import { describe, expect, it } from "vitest";

import type { SessionToolCall } from "@/hooks/use-session-messages";
import {
  applyLiveToolEvent,
  mergeToolCalls,
  type LiveToolEvent,
} from "@/lib/live-tool-calls";

type StartEvent = Extract<LiveToolEvent, { type: "tool-start" }>;

const start = (
  toolCallId: string,
  at: string,
  extra: Pick<StartEvent, "params" | "summary"> | object = {},
): StartEvent => ({
  at,
  toolCallId,
  toolName: "bash",
  type: "tool-start",
  ...extra,
});

const end = (toolCallId: string, at: string, isError = false): LiveToolEvent => ({
  at,
  isError,
  toolCallId,
  toolName: "bash",
  type: "tool-end",
});

describe("applyLiveToolEvent", () => {
  it("appends a row on tool-start so the marker exists before the call finishes", () => {
    const calls = applyLiveToolEvent([], start("call-1", "2026-08-26T10:00:00.000Z"));

    expect(calls).toEqual([
      {
        createdAt: "2026-08-26T10:00:00.000Z",
        id: "call-1",
        messageId: "",
        name: "bash",
      },
    ]);
    expect(calls[0].resultAt).toBeUndefined();
  });

  it("carries the summary and params through to the marker label", () => {
    const [call] = applyLiveToolEvent(
      [],
      start("call-1", "2026-08-26T10:00:00.000Z", {
        params: { command: "npm test" },
        summary: "npm test",
      }),
    );

    expect(call.summary).toBe("npm test");
    expect(call.params).toEqual({ command: "npm test" });
  });

  it("closes the matching row on tool-end without adding a second one", () => {
    const started = applyLiveToolEvent([], start("call-1", "2026-08-26T10:00:00.000Z"));
    const closed = applyLiveToolEvent(started, end("call-1", "2026-08-26T10:00:02.000Z"));

    expect(closed).toHaveLength(1);
    expect(closed[0].createdAt).toBe("2026-08-26T10:00:00.000Z");
    expect(closed[0].resultAt).toBe("2026-08-26T10:00:02.000Z");
    expect(closed[0].isError).toBe(false);
  });

  it("records the result time and error flag on the right row", () => {
    let calls = applyLiveToolEvent([], start("call-1", "2026-08-26T10:00:00.000Z"));
    calls = applyLiveToolEvent(calls, start("call-2", "2026-08-26T10:00:01.000Z"));
    calls = applyLiveToolEvent(calls, end("call-2", "2026-08-26T10:00:03.000Z", true));

    expect(calls[0].resultAt).toBeUndefined();
    expect(calls[1].resultAt).toBe("2026-08-26T10:00:03.000Z");
    expect(calls[1].isError).toBe(true);
  });

  it("ignores a repeated start and an unmatched end", () => {
    const once = applyLiveToolEvent([], start("call-1", "2026-08-26T10:00:00.000Z"));
    const twice = applyLiveToolEvent(once, start("call-1", "2026-08-26T10:00:05.000Z"));

    expect(twice).toHaveLength(1);
    expect(twice[0].createdAt).toBe("2026-08-26T10:00:00.000Z");
    expect(applyLiveToolEvent(once, end("other", "2026-08-26T10:00:09.000Z"))).toEqual(
      once,
    );
  });
});

describe("mergeToolCalls", () => {
  const persisted: SessionToolCall = {
    createdAt: "2026-08-26T10:00:00.000Z",
    id: "call-1",
    messageId: "entry-7",
    name: "bash",
    resultAt: "2026-08-26T10:00:02.000Z",
    resultText: "ok",
  };

  it("replaces a live row with the persisted one of the same id", () => {
    const live = applyLiveToolEvent([], start("call-1", "2026-08-26T10:00:00.000Z"));
    const merged = mergeToolCalls([persisted], live);

    expect(merged).toHaveLength(1);
    // The persisted row is what carries messageId and result text.
    expect(merged[0].messageId).toBe("entry-7");
    expect(merged[0].resultText).toBe("ok");
  });

  it("keeps live rows the transcript has not caught up to yet", () => {
    const live = applyLiveToolEvent(
      applyLiveToolEvent([], start("call-1", "2026-08-26T10:00:00.000Z")),
      start("call-2", "2026-08-26T10:00:04.000Z"),
    );

    expect(mergeToolCalls([persisted], live).map((call) => call.id)).toEqual([
      "call-1",
      "call-2",
    ]);
  });

  it("orders by start time so markers do not jump when the refetch lands", () => {
    const live = applyLiveToolEvent([], start("call-0", "2026-08-26T09:59:00.000Z"));

    expect(mergeToolCalls([persisted], live).map((call) => call.id)).toEqual([
      "call-0",
      "call-1",
    ]);
  });

  it("returns the live rows alone before anything is persisted", () => {
    const live = applyLiveToolEvent([], start("call-1", "2026-08-26T10:00:00.000Z"));

    expect(mergeToolCalls([], live)).toEqual(live);
  });
});
