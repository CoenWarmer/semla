/**
 * The behaviour worth pinning is the grouping boundary: a run of silent turns
 * becomes one strip, and a turn that says something ends the run. Getting that
 * wrong is what turns fifteen empty boxes into fifteen chips, which is barely an
 * improvement on the bug being fixed.
 */
import { describe, expect, it } from "vitest";

import type { SessionMessage, SessionToolCall } from "@/hooks/use-session-messages";
import { groupConversation, summariseSteps } from "./session-steps.ts";

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

  it("folds a live round's tool call into a steps group via its placeholder pseudo-message", () => {
    // A call still streaming has no real assistant message yet — the caller
    // adds a pseudo-message per live round (see live-rounds.ts) carrying a
    // liveRoundMessageId so this can attach it rather than dropping it until
    // the turn ends.
    const items = groupConversation(
      [message("u", "user", "question"), message("live-round-message:live-round-1", "assistant", "")],
      [call("c1", "live-round-message:live-round-1", "bash")],
    );

    expect(items.map((item) => item.kind)).toEqual(["message", "steps"]);
    expect(items[1].kind === "steps" && items[1].items).toHaveLength(1);
  });

  it("interleaves several live rounds the same way it interleaves persisted turns", () => {
    // A turn that said something, called a tool, then said more, produces one
    // pseudo-message per round trip in order — groupConversation needs no
    // special-casing to interleave them correctly, the same as it already
    // does for the equivalent persisted messages once the turn ends.
    const items = groupConversation(
      [
        message("u", "user", "question"),
        message("live-round-message:live-round-1", "assistant", "Let me check that."),
        message("live-round-message:live-round-2", "assistant", ""),
        message("live-round-message:live-round-3", "assistant", "Found it."),
      ],
      [call("c1", "live-round-message:live-round-2", "bash")],
    );

    expect(items.map((item) => item.kind)).toEqual([
      "message",
      "message",
      "steps",
      "message",
    ]);
  });

  it("lifts an ask_user call out of the strip as its own item", () => {
    const items = groupConversation(
      [message("u", "user", "question"), message("a", "assistant", "")],
      [
        {
          ...call("c1", "a", "ask_user"),
          resultText: "How prominent?\n\u2192 card",
        },
      ],
    );

    expect(items.map((item) => item.kind)).toEqual(["message", "ask"]);
    expect(items[1].kind === "ask" && items[1].pairs).toEqual([
      { answer: "card", question: "How prominent?" },
    ]);
  });

  it("renders nothing for an ask still waiting on an answer", () => {
    // Mid-turn, between the question arriving and the reader answering it. The
    // answer dialog is already showing these questions, so a card here would
    // ask them twice with nothing under them.
    const items = groupConversation(
      [message("live-round-message:live-round-1", "assistant", "")],
      [call("c1", "live-round-message:live-round-1", "ask_user")],
    );

    expect(items).toEqual([]);
  });

  it("keeps a pending ask out of the strip as well as out of the asks", () => {
    // Otherwise the fold catches what the ask path declined, and it comes back
    // as an unlabelled dot for the duration of the question.
    const items = groupConversation(
      [message("a", "assistant", "")],
      [call("c1", "a", "bash"), call("c2", "a", "ask_user")],
    );

    expect(items.map((item) => item.kind)).toEqual(["steps"]);
    expect(items[0].kind === "steps" && items[0].items).toHaveLength(1);
  });

  it("renders the card as soon as a live tool-end carries the answers", () => {
    // applyLiveToolEvent sets resultAt on tool-end, which is what tells this
    // apart from the pending row above — mid-turn, before any persisted row.
    const items = groupConversation(
      [message("live-round-message:live-round-1", "assistant", "")],
      [
        {
          ...call("c1", "live-round-message:live-round-1", "ask_user"),
          resultAt: "2026-09-01T10:00:01.000Z",
          resultText: "Live?\n\u2192 yes",
        },
      ],
    );

    expect(items.map((item) => item.kind)).toEqual(["ask"]);
    expect(items[0].kind === "ask" && items[0].pairs).toEqual([
      { answer: "yes", question: "Live?" },
    ]);
  });

  it("lifts an ask out of a turn that did have text", () => {
    // The common case in practice: the agent explains why it is asking, so the
    // turn is not silent and the fold path never sees it.
    const items = groupConversation(
      [message("a", "assistant", "A few things determine the design:")],
      [{ ...call("c1", "a", "ask_user"), resultText: "Which one?\n\u2192 the second" }],
    );

    expect(items.map((item) => item.kind)).toEqual(["message", "ask"]);
    expect(items[1].kind === "ask" && items[1].pairs).toEqual([
      { answer: "the second", question: "Which one?" },
    ]);
  });

  it("keeps the other calls of the same turn in the strip, before the ask", () => {
    const items = groupConversation(
      [message("u", "user", "q"), message("a", "assistant", "", "thought")],
      [
        call("c1", "a", "bash"),
        { ...call("c2", "a", "ask_user"), resultText: "A?\n\u2192 a" },
      ],
    );

    expect(items.map((item) => item.kind)).toEqual(["message", "steps", "ask"]);
    expect(items[1].kind === "steps" && items[1].items.map((i) => i.kind)).toEqual([
      "thinking",
      "tool",
    ]);
  });

  it("ends the run, so a later silent turn starts a new strip", () => {
    // Otherwise the strip after the question absorbs into the one before it and
    // renders above the answers that caused it.
    const items = groupConversation(
      [message("a1", "assistant", ""), message("a2", "assistant", "")],
      [
        { ...call("c1", "a1", "ask_user"), resultText: "A?\n\u2192 a" },
        call("c2", "a2", "bash"),
      ],
    );

    expect(items.map((item) => item.kind)).toEqual(["ask", "steps"]);
  });

  it("marks a cancelled ask and keeps its error text verbatim", () => {
    const items = groupConversation(
      [message("a", "assistant", "")],
      [
        {
          ...call("c1", "a", "ask_user"),
          errorText: "ask_user was cancelled: aborted",
          // isError alone must be enough: a cancellation is not pending, even
          // though the client may see the error before any resultAt.
          isError: true,
        },
      ],
    );

    expect(items).toHaveLength(1);
    expect(items[0].kind === "ask" && items[0].cancelled).toBe(true);
    expect(items[0].kind === "ask" && items[0].pairs).toEqual([]);
    expect(items[0].kind === "ask" && items[0].raw).toBe(
      "ask_user was cancelled: aborted",
    );
  });

  it("does not count an ask_user call in the strip summary", () => {
    const items = groupConversation(
      [message("a", "assistant", "")],
      [
        call("c1", "a", "bash"),
        { ...call("c2", "a", "ask_user"), resultText: "A?\n\u2192 a" },
      ],
    );

    const steps = items[0].kind === "steps" ? items[0].items : [];
    expect(summariseSteps(steps)).toBe("bash");
  });

  it("annotates every step of a turn with that turn's usage and call count", () => {
    const silent: SessionMessage = {
      ...message("s1", "assistant", "", "why"),
      tokenUsage: { cost: 0.05, total: 20_000 },
    };

    const items = groupConversation(
      [message("u", "user", "question"), silent],
      [call("c1", "s1", "bash"), call("c2", "s1", "read")],
    );

    const steps = items[1].kind === "steps" ? items[1].items : [];
    // Thinking plus two calls, all three carrying the same figures, and all
    // three saying the turn made two calls so the reader can see it is shared.
    expect(steps).toHaveLength(3);
    expect(steps.map((step) => step.usage)).toEqual([
      { callsInTurn: 2, cost: 0.05, tokens: 20_000 },
      { callsInTurn: 2, cost: 0.05, tokens: 20_000 },
      { callsInTurn: 2, cost: 0.05, tokens: 20_000 },
    ]);
  });

  it("leaves usage absent on a turn that reported none", () => {
    const items = groupConversation(
      [message("s1", "assistant", "", "why")],
      [call("c1", "s1", "bash")],
    );

    const steps = items[0].kind === "steps" ? items[0].items : [];
    expect(steps.every((step) => step.usage === undefined)).toBe(true);
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
