/**
 * A run that settles to a terminal status (completed/failed/aborted) must
 * not leave any agent behind claiming "queued" or "running" — that agent's
 * own onAgentEnd may never fire (e.g. an abort cuts it off mid-turn), and
 * Semla's countSessionAgents sums agent.status === "running" across every
 * run a session has ever had with no cross-check against the run's own
 * status, so a leftover "running" agent shows a session as permanently
 * live. See skipUnfinishedAgents's doc comment in display.ts.
 */
import { describe, expect, it } from "vitest";

import { skipUnfinishedAgents } from "./display.ts";

describe("skipUnfinishedAgents", () => {
  it("flips a running agent to skipped", () => {
    const agents = [{ id: 1, status: "running" as const }];

    expect(skipUnfinishedAgents(agents)).toEqual([{ id: 1, status: "skipped" }]);
  });

  it("flips a queued agent to skipped", () => {
    const agents = [{ id: 1, status: "queued" as const }];

    expect(skipUnfinishedAgents(agents)).toEqual([{ id: 1, status: "skipped" }]);
  });

  it("leaves already-terminal agents untouched", () => {
    const agents = [
      { id: 1, status: "done" as const },
      { id: 2, status: "error" as const },
      { id: 3, status: "skipped" as const },
    ];

    expect(skipUnfinishedAgents(agents)).toEqual(agents);
  });

  it("only rewrites the agents that actually need it", () => {
    const done = { id: 1, status: "done" as const };
    const agents = [done, { id: 2, status: "running" as const }];

    const result = skipUnfinishedAgents(agents);

    expect(result[0]).toBe(done);
    expect(result[1]).not.toBe(agents[1]);
  });

  it("handles an empty run", () => {
    expect(skipUnfinishedAgents([])).toEqual([]);
  });
});
