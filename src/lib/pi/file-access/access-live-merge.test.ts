import { describe, expect, it } from "vitest";

import type { SessionToolCall } from "@/hooks/use-session-messages";

import { toolCallStepsFromLive } from "./access-live-merge.ts";
import { LIVE_TURN_ID, type FileAccess } from "./access-types.ts";

const liveCall = (over: Partial<SessionToolCall> = {}): SessionToolCall => ({
  createdAt: "2026-01-01T00:00:00.000Z",
  id: "c1",
  messageId: "m1",
  name: "read",
  ...over,
});

const liveAccess = (over: Partial<FileAccess> = {}): FileAccess => ({
  agent: { id: "main", label: "Main" },
  at: "2026-01-01T00:00:00.000Z",
  callId: "c1",
  confidence: "exact",
  id: "c1",
  kind: "read",
  missing: false,
  path: "src/a.ts",
  project: "semla",
  ranges: [],
  tool: "read",
  turnId: LIVE_TURN_ID,
  ...over,
});

describe("toolCallStepsFromLive", () => {
  it("attaches a call's access to its own step", () => {
    const steps = toolCallStepsFromLive([liveCall()], [liveAccess()]);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      accesses: [liveAccess()],
      id: "c1",
      name: "read",
      turnId: LIVE_TURN_ID,
    });
  });

  it("gives a call that touched nothing an empty accesses list, not a dropped step", () => {
    const steps = toolCallStepsFromLive(
      [liveCall({ id: "c1", name: "ask_user" })],
      [],
    );
    expect(steps).toEqual([
      {
        accesses: [],
        agent: { id: "main", label: "Main" },
        at: "2026-01-01T00:00:00.000Z",
        id: "c1",
        isError: false,
        name: "ask_user",
        turnId: LIVE_TURN_ID,
      },
    ]);
  });

  it("groups several accesses from one call under that one step", () => {
    const steps = toolCallStepsFromLive(
      [liveCall({ id: "c1", name: "bash" })],
      [
        liveAccess({ callId: "c1", id: "c1#0", path: "src/a.ts" }),
        liveAccess({ callId: "c1", id: "c1#1", path: "src/b.ts" }),
      ],
    );
    expect(steps[0]?.accesses.map((access) => access.path)).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  it("keeps two calls' accesses apart by callId", () => {
    const steps = toolCallStepsFromLive(
      [liveCall({ id: "c1" }), liveCall({ createdAt: "2026-01-01T00:00:01.000Z", id: "c2" })],
      [liveAccess({ callId: "c1", path: "src/a.ts" }), liveAccess({ callId: "c2", id: "c2", path: "src/b.ts" })],
    );
    expect(steps[0]?.accesses.map((a) => a.path)).toEqual(["src/a.ts"]);
    expect(steps[1]?.accesses.map((a) => a.path)).toEqual(["src/b.ts"]);
  });

  it("carries the call's summary and error state through", () => {
    const steps = toolCallStepsFromLive(
      [liveCall({ isError: true, summary: "npm test" })],
      [],
    );
    expect(steps[0]).toMatchObject({ isError: true, summary: "npm test" });
  });

  it("orders steps by the order calls started, not by access order", () => {
    const steps = toolCallStepsFromLive(
      [liveCall({ id: "c1" }), liveCall({ createdAt: "2026-01-01T00:00:01.000Z", id: "c2" })],
      [liveAccess({ callId: "c2", id: "c2" })],
    );
    expect(steps.map((step) => step.id)).toEqual(["c1", "c2"]);
  });
});
