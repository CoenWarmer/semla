import { describe, expect, it } from "vitest";

import type { SessionToolCall } from "@/hooks/use-session-messages";
import {
  applyLiveToolEvent,
  liveRoundMessageId,
  isLiveRoundMessageId,
  mergeToolCalls,
  type LiveToolEvent,
} from "@/lib/live-tool-calls";

type StartEvent = Extract<LiveToolEvent, { type: "tool-start" }>;

const start = (
  toolCallId: string,
  at: string,
  extra: Pick<StartEvent, "params" | "summary" | "roundId"> | object = {},
): StartEvent => ({
  at,
  roundId: "live-round-1",
  toolCallId,
  toolName: "bash",
  type: "tool-start",
  ...extra,
});

const end = (
  toolCallId: string,
  at: string,
  isError = false,
  extra: Pick<Extract<LiveToolEvent, { type: "tool-end" }>, "errorText" | "resultText" | "roundId"> | object = {},
): LiveToolEvent => ({
  at,
  isError,
  roundId: "live-round-1",
  toolCallId,
  toolName: "bash",
  type: "tool-end",
  ...extra,
});

describe("applyLiveToolEvent", () => {
  it("appends a row on tool-start so the marker exists before the call finishes", () => {
    const calls = applyLiveToolEvent([], start("call-1", "2026-08-26T10:00:00.000Z"));

    expect(calls).toEqual([
      {
        createdAt: "2026-08-26T10:00:00.000Z",
        id: "call-1",
        messageId: liveRoundMessageId("live-round-1"),
        name: "bash",
      },
    ]);
    expect(calls[0].resultAt).toBeUndefined();
  });

  it("tags the row with the round it belongs to, distinguishable from a real persisted messageId", () => {
    const [call] = applyLiveToolEvent(
      [],
      start("call-1", "2026-08-26T10:00:00.000Z", { roundId: "live-round-2" }),
    );

    expect(call.messageId).toBe(liveRoundMessageId("live-round-2"));
    expect(isLiveRoundMessageId(call.messageId)).toBe(true);
    expect(isLiveRoundMessageId("a-real-persisted-uuid")).toBe(false);
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

  it("carries the tool's response text onto the row, so the drawer can show it before the turn ends", () => {
    const started = applyLiveToolEvent([], start("call-1", "2026-08-26T10:00:00.000Z"));
    const closed = applyLiveToolEvent(
      started,
      end("call-1", "2026-08-26T10:00:02.000Z", false, { resultText: "total 0\ndrwxr-xr-x" }),
    );

    expect(closed[0].resultText).toBe("total 0\ndrwxr-xr-x");
    expect(closed[0].errorText).toBeUndefined();
  });

  it("carries the error text separately when the call failed", () => {
    const started = applyLiveToolEvent([], start("call-1", "2026-08-26T10:00:00.000Z"));
    const closed = applyLiveToolEvent(
      started,
      end("call-1", "2026-08-26T10:00:02.000Z", true, { errorText: "no such file" }),
    );

    expect(closed[0].errorText).toBe("no such file");
    expect(closed[0].isError).toBe(true);
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
