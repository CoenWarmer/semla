import { describe, expect, it } from "vitest";

import { stampLiveTimestamps } from "@/lib/pi/workflow-snapshot-merge";

type StampableAgent = {
  endedAt?: string;
  id: number;
  label: string;
  startedAt?: string;
  status: string;
};

type StampableSnapshot = {
  agentCount: number;
  agents: StampableAgent[];
  doneCount: number;
  errorCount: number;
  logs?: string[];
  name: string;
  phases: string[];
  runId: string;
  runningCount: number;
  startedAt?: string;
};

/** A snapshot exactly as it arrives off the SSE stream: no timestamps at all. */
const rawSnapshot = (): StampableSnapshot => ({
  agentCount: 2,
  agents: [
    { id: 1, label: "agent 1", status: "running" },
    { id: 2, label: "agent 2", status: "running" },
  ],
  doneCount: 0,
  errorCount: 0,
  // Extras the typed WorkflowSnapshot does not declare but the debug writer keeps.
  logs: ["Agent 1: …"],
  name: "cute_animals",
  phases: [],
  runId: "run-a",
  runningCount: 2,
});

const clockFrom = (...times: string[]) => {
  let i = 0;
  return () => times[Math.min(i++, times.length - 1)];
};

describe("stampLiveTimestamps", () => {
  it("gives every live agent a start, so its bar is not drawn full-width", () => {
    const stamped = stampLiveTimestamps(
      "run-1",
      rawSnapshot(),
      clockFrom("2026-08-26T21:22:50.000Z"),
    );

    expect(stamped.agents.map((a) => a.startedAt)).toEqual([
      "2026-08-26T21:22:50.000Z",
      "2026-08-26T21:22:50.000Z",
    ]);
    // A running agent has not ended, so it must not gain an end.
    expect(stamped.agents.every((a) => a.endedAt === undefined)).toBe(true);
  });

  it("derives the run start from the earliest agent", () => {
    const stamped = stampLiveTimestamps(
      "run-2",
      rawSnapshot(),
      clockFrom("2026-08-26T21:22:53.000Z", "2026-08-26T21:22:50.000Z"),
    );

    expect(stamped.startedAt).toBe("2026-08-26T21:22:50.000Z");
  });

  it("holds each agent's first-seen time steady across repeated snapshots", () => {
    // The stream emits a snapshot every 250ms; the bar must grow from a fixed
    // start rather than sliding along with the clock.
    const clock = clockFrom(
      "2026-08-26T21:22:50.000Z",
      "2026-08-26T21:22:50.000Z",
      "2026-08-26T21:22:59.000Z",
      "2026-08-26T21:22:59.000Z",
    );
    stampLiveTimestamps("run-3", rawSnapshot(), clock);
    const second = stampLiveTimestamps("run-3", rawSnapshot(), clock);

    expect(second.agents[0].startedAt).toBe("2026-08-26T21:22:50.000Z");
    expect(second.startedAt).toBe("2026-08-26T21:22:50.000Z");
  });

  it("stamps an end once an agent reaches a terminal status", () => {
    const clock = clockFrom("2026-08-26T21:22:50.000Z", "2026-08-26T21:23:02.000Z");
    stampLiveTimestamps("run-4", rawSnapshot(), clock);

    const done = stampLiveTimestamps(
      "run-4",
      {
        ...rawSnapshot(),
        agents: [{ id: 1, label: "agent 1", status: "done" } as StampableAgent],
      },
      clock,
    );

    expect(done.agents[0].startedAt).toBe("2026-08-26T21:22:50.000Z");
    expect(done.agents[0].endedAt).toBe("2026-08-26T21:23:02.000Z");
  });

  it("never overwrites a timestamp the run already recorded", () => {
    const stamped = stampLiveTimestamps(
      "run-5",
      {
        ...rawSnapshot(),
        agents: [
          {
            endedAt: "2026-08-26T09:00:05.000Z",
            id: 1,
            label: "agent 1",
            startedAt: "2026-08-26T09:00:00.000Z",
            status: "done",
          },
        ],
        startedAt: "2026-08-26T08:59:59.000Z",
      },
      clockFrom("2026-08-26T21:22:50.000Z"),
    );

    expect(stamped.startedAt).toBe("2026-08-26T08:59:59.000Z");
    expect(stamped.agents[0].startedAt).toBe("2026-08-26T09:00:00.000Z");
    expect(stamped.agents[0].endedAt).toBe("2026-08-26T09:00:05.000Z");
  });

  it("preserves fields outside the declared snapshot shape", () => {
    const stamped = stampLiveTimestamps(
      "run-6",
      rawSnapshot(),
      clockFrom("2026-08-26T21:22:50.000Z"),
    );

    expect(stamped.logs).toEqual(["Agent 1: …"]);
    expect(stamped.name).toBe("cute_animals");
    expect(stamped.agents[0].label).toBe("agent 1");
  });
});
