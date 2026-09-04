import { describe, expect, it } from "vitest";

import {
  applyRoundDelta,
  applyRoundStart,
  liveRoundMessages,
  type LiveRound,
} from "@/lib/live-rounds";
import { liveRoundMessageId } from "@/lib/live-tool-calls";

describe("applyRoundStart", () => {
  it("appends a new, empty round", () => {
    const rounds = applyRoundStart([], { roundId: "live-round-1" });

    expect(rounds).toEqual([{ id: "live-round-1", text: "" }]);
  });

  it("appends a second round after the first, in order", () => {
    const rounds = applyRoundStart(
      applyRoundStart([], { roundId: "live-round-1" }),
      { roundId: "live-round-2" },
    );

    expect(rounds.map((r) => r.id)).toEqual(["live-round-1", "live-round-2"]);
  });

  it("ignores a repeated round-start for the same id", () => {
    const once = applyRoundStart([], { roundId: "live-round-1" });
    const twice = applyRoundStart(once, { roundId: "live-round-1" });

    expect(twice).toHaveLength(1);
  });
});

describe("applyRoundDelta", () => {
  it("appends the delta onto the round it belongs to", () => {
    let rounds: LiveRound[] = applyRoundStart([], { roundId: "live-round-1" });
    rounds = applyRoundDelta(rounds, { delta: "Hel", roundId: "live-round-1" });
    rounds = applyRoundDelta(rounds, { delta: "lo", roundId: "live-round-1" });

    expect(rounds).toEqual([{ id: "live-round-1", text: "Hello" }]);
  });

  it("keeps two rounds' text apart, so one round's deltas never bleed into another's", () => {
    let rounds: LiveRound[] = applyRoundStart([], { roundId: "live-round-1" });
    rounds = applyRoundDelta(rounds, { delta: "First reply", roundId: "live-round-1" });
    rounds = applyRoundStart(rounds, { roundId: "live-round-2" });
    rounds = applyRoundDelta(rounds, { delta: "Second reply", roundId: "live-round-2" });

    expect(rounds).toEqual([
      { id: "live-round-1", text: "First reply" },
      { id: "live-round-2", text: "Second reply" },
    ]);
  });

  it("creates the round if a delta somehow arrives before its round-start", () => {
    const rounds = applyRoundDelta([], { delta: "text", roundId: "live-round-1" });

    expect(rounds).toEqual([{ id: "live-round-1", text: "text" }]);
  });
});

describe("liveRoundMessages", () => {
  it("turns each round into a pseudo assistant message carrying the live-round messageId", () => {
    const rounds: LiveRound[] = [
      { id: "live-round-1", text: "Let me check that." },
      { id: "live-round-2", text: "" },
    ];

    const messages = liveRoundMessages(rounds);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      id: liveRoundMessageId("live-round-1"),
      role: "assistant",
      text: "Let me check that.",
    });
    expect(messages[1]).toMatchObject({
      id: liveRoundMessageId("live-round-2"),
      role: "assistant",
      text: "",
    });
  });

  it("preserves round order, so groupConversation interleaves them the way they happened", () => {
    const rounds: LiveRound[] = [
      { id: "live-round-1", text: "a" },
      { id: "live-round-2", text: "b" },
      { id: "live-round-3", text: "c" },
    ];

    expect(liveRoundMessages(rounds).map((m) => m.text)).toEqual(["a", "b", "c"]);
  });
});
