/**
 * The behaviour worth pinning is the grouping boundary: a run of silent turns
 * becomes one strip, and a turn that says something ends the run. Getting that
 * wrong is what turns fifteen empty boxes into fifteen chips, which is barely an
 * improvement on the bug being fixed.
 */
import { describe, expect, it } from "vitest";

import type { SessionMessage, SessionToolCall } from "@/hooks/use-session-messages";
import { groupConversation, splitLiveSteps, summariseSteps } from "./session-steps.ts";

const message = (
  id: string,
  role: "assistant" | "user",
  text: string,
  thinking?: string,
): SessionMessage => ({
  createdAt: "2026-09-01T10:00:00.000Z",
  id,
  role,
  text,
  ...(thinking ? { thinking } : {}),
});

const call = (id: string, messageId: string, name: string): SessionToolCall => ({
  createdAt: "2026-09-01T10:00:00.000Z",
  id,
  messageId,
  name,
});

describe("groupConversation", () => {
  it("leaves turns that have text alone", () => {
    const items = groupConversation([
      message("u", "user", "question"),
      message("a", "assistant", "answer"),
    ]);

    expect(items.map((item) => item.kind)).toEqual(["message", "message"]);
  });

  it("folds a run of silent turns into a single group", () => {
    const items = groupConversation(
      [
        message("u", "user", "question"),
        message("s1", "assistant", "", "thinking one"),
        message("s2", "assistant", "", "thinking two"),
        message("s3", "assistant", "", "thinking three"),
        message("a", "assistant", "answer"),
      ],
      [call("c1", "s1", "bash"), call("c2", "s2", "bash"), call("c3", "s3", "read")],
    );

    expect(items.map((item) => item.kind)).toEqual(["message", "steps", "message"]);
    // Three turns, each a thought and a call, in one strip.
    expect(items[1].kind === "steps" && items[1].items).toHaveLength(6);
  });

  it("starts a new group after a turn that spoke", () => {
    const items = groupConversation(
      [
        message("s1", "assistant", "", "one"),
        message("a", "assistant", "said something"),
        message("s2", "assistant", "", "two"),
      ],
      [],
    );

    expect(items.map((item) => item.kind)).toEqual(["steps", "message", "steps"]);
  });

  it("puts the reasoning before the calls it explains", () => {
    const items = groupConversation(
      [message("s1", "assistant", "", "why I am about to run this")],
      [call("c1", "s1", "bash")],
    );

    expect(items[0].kind === "steps" && items[0].items.map((i) => i.kind)).toEqual([
      "thinking",
      "tool",
    ]);
  });

  it("drops a silent turn that really is empty", () => {
    // No reasoning, no calls: a dot here would open onto nothing.
    expect(groupConversation([message("s1", "assistant", "")], [])).toEqual([]);
  });

  it("does not pull calls out of a turn that had text", () => {
    // Those already show on the timeline; moving them would change turns that
    // were never the problem.
    const items = groupConversation(
      [message("a", "assistant", "answer")],
      [call("c1", "a", "bash")],
    );

    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("message");
  });

  it("never folds a user message", () => {
    const items = groupConversation([message("u", "user", "")], []);

    expect(items.map((item) => item.kind)).toEqual(["message"]);
  });

  it("folds a live tool call into a steps group via the placeholder live-turn message", () => {
    // A call still streaming has no real assistant message yet — the caller
    // adds a placeholder carrying LIVE_MESSAGE_ID (see live-tool-calls.ts) so
    // this can attach it rather than dropping it until the turn ends.
    const items = groupConversation(
      [message("u", "user", "question"), message("live-turn", "assistant", "")],
      [call("c1", "live-turn", "bash")],
    );

    expect(items.map((item) => item.kind)).toEqual(["message", "steps"]);
    expect(items[1].kind === "steps" && items[1].items).toHaveLength(1);
  });
});

describe("splitLiveSteps", () => {
  it("pulls the trailing live-turn steps off so they can render after the streaming answer", () => {
    const items = groupConversation(
      [message("u", "user", "question"), message("live-turn", "assistant", "")],
      [call("c1", "live-turn", "bash")],
    );

    const { historyItems, liveSteps } = splitLiveSteps(items, "live-turn");

    expect(historyItems.map((item) => item.kind)).toEqual(["message"]);
    expect(liveSteps?.items).toHaveLength(1);
  });

  it("leaves everything in historyItems when nothing is live", () => {
    const items = groupConversation(
      [message("u", "user", "question"), message("a", "assistant", "answer")],
      [],
    );

    const { historyItems, liveSteps } = splitLiveSteps(items, "live-turn");

    expect(historyItems).toEqual(items);
    expect(liveSteps).toBeNull();
  });

  it("does not mistake an earlier, already-finished steps group for the live one", () => {
    const items = groupConversation(
      [
        message("s1", "assistant", "", "earlier thought"),
        message("a", "assistant", "answer"),
      ],
      [call("c1", "s1", "bash")],
    );

    const { historyItems, liveSteps } = splitLiveSteps(items, "live-turn");

    expect(historyItems).toEqual(items);
    expect(liveSteps).toBeNull();
  });

  it("keeps an already-finished turn's steps behind when groupConversation merged it with the live one", () => {
    // The turn right before the live one was itself silent (say it ended in a
    // tool error with no closing text), so groupConversation folds its steps
    // into the same trailing group as the live-turn placeholder. Only the
    // live steps should move past the streaming answer — the finished ones
    // stay in their historical position.
    const items = groupConversation(
      [
        message("u1", "user", "q1"),
        message("s0", "assistant", "", "earlier finished thought"),
        message("live-turn", "assistant", ""),
      ],
      [call("c0", "s0", "bash"), call("c1", "live-turn", "read")],
    );

    const { historyItems, liveSteps } = splitLiveSteps(items, "live-turn");

    expect(historyItems.map((item) => item.kind)).toEqual(["message", "steps"]);
    const finishedGroup = historyItems[1];
    expect(finishedGroup.kind === "steps" && finishedGroup.items).toHaveLength(2);
    expect(
      finishedGroup.kind === "steps" &&
        finishedGroup.items.every((item) => item.messageId === "s0"),
    ).toBe(true);

    expect(liveSteps?.items).toHaveLength(1);
    expect(liveSteps?.items.every((item) => item.messageId === "live-turn")).toBe(
      true,
    );
  });
});

describe("summariseSteps", () => {
  it("counts repeated tools and names the rest", () => {
    const items = groupConversation(
      [
        message("s1", "assistant", "", "t"),
        message("s2", "assistant", ""),
        message("s3", "assistant", ""),
      ],
      [call("c1", "s1", "bash"), call("c2", "s2", "bash"), call("c3", "s3", "code_map")],
    );

    const steps = items[0].kind === "steps" ? items[0].items : [];
    expect(summariseSteps(steps)).toBe("2 bash · code_map · 1 thought");
  });

  it("reads sensibly with reasoning only", () => {
    const items = groupConversation([message("s1", "assistant", "", "just thinking")], []);
    const steps = items[0].kind === "steps" ? items[0].items : [];

    expect(summariseSteps(steps)).toBe("1 thought");
  });
});
