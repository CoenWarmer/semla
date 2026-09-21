/**
 * Which turn a gate decision is shown on.
 *
 * The fixtures below are the real shape observed in
 * `.semla-sessions/cb87ec42-…jsonl` on 2026-09-21, where every badge's record
 * list read `[2, 3, …, 9, 1]`. The trailing `1` was the *next* turn's opening
 * decision, written at `before_agent_start` before the new prompt had been
 * appended to the tree, and therefore parented to the previous turn's tail.
 */
import { describe, expect, it } from "vitest";

import { JEV_GATE_CUSTOM_TYPE } from "@/lib/pi/extensions/jev-gate/gate-record";
import type { RoleAttributableEntry } from "./custom-entry-attribution.ts";
import { jevGateTextByUserMessageId } from "./jev-gate-attribution.ts";

const msg = (
  id: string,
  role: string,
  parentId: string | null,
): RoleAttributableEntry => ({ id, parentId, role, type: "message" });

/**
 * A gate record. `evaluation` is the field that distinguishes a turn-start
 * decision from a mid-turn re-check, so it is what the fixtures vary.
 */
const gate = (
  id: string,
  parentId: string,
  evaluation: number,
): RoleAttributableEntry => ({
  content: JSON.stringify({
    evaluation,
    outcome: "decided",
    skills: [],
    tools: ["read"],
  }),
  customType: JEV_GATE_CUSTOM_TYPE,
  id,
  parentId,
  role: undefined,
  type: "custom_message",
});

const evaluations = (texts: string[] | undefined): number[] =>
  (texts ?? []).map((t) => (JSON.parse(t) as { evaluation: number }).evaluation);

/**
 * Two complete turns. Turn 2's opening decision (`g2-1`) is parented to `a1`,
 * turn 1's trailing assistant message — the displacement itself.
 */
const twoTurns: RoleAttributableEntry[] = [
  msg("u1", "user", null),
  msg("a1", "assistant", "u1"),
  gate("g1-2", "t1", 2),
  msg("t1", "toolResult", "a1"),

  // Written at turn 2's start, while `a1` was still the leaf.
  gate("g2-1", "a1", 1),
  msg("u2", "user", "a1"),
  msg("a2", "assistant", "u2"),
  msg("t2", "toolResult", "a2"),
  gate("g2-2", "t2", 2),
];

describe("jevGateTextByUserMessageId", () => {
  it("moves a turn-start decision forward to the prompt it governed", () => {
    const byPrompt = jevGateTextByUserMessageId(twoTurns);

    // Turn 2's opener belongs to `u2`, ahead of that turn's own re-check.
    expect(evaluations(byPrompt.get("u2"))).toEqual([1, 2]);
    // And is gone from turn 1, which keeps only its own mid-turn record.
    expect(evaluations(byPrompt.get("u1"))).toEqual([2]);
  });

  it("shows no decisions for a turn during which the gate never ran", () => {
    // The reported symptom: the prompt "in the spec I requested that an icon…"
    // carried one record although the gate was switched off for its turn. The
    // record was the *following* turn's opener.
    const gateOffThenOn: RoleAttributableEntry[] = [
      msg("u1", "user", null),
      msg("a1", "assistant", "u1"),
      gate("g2-1", "a1", 1),
      msg("u2", "user", "a1"),
    ];

    const byPrompt = jevGateTextByUserMessageId(gateOffThenOn);

    expect(byPrompt.has("u1")).toBe(false);
    expect(evaluations(byPrompt.get("u2"))).toEqual([1]);
  });

  it("leaves a turn-start decision on its own prompt when it was recorded in time", () => {
    // No agent message between record and prompt — the first turn of a
    // session, where there is no previous assistant to be displaced onto.
    // Moving this one forward would break the case that already worked.
    const firstTurn: RoleAttributableEntry[] = [
      msg("u1", "user", null),
      { ...gate("g1-1", "u1", 1) },
      msg("a1", "assistant", "u1"),
    ];

    expect(evaluations(jevGateTextByUserMessageId(firstTurn).get("u1"))).toEqual([1]);
  });

  it("keeps a turn-start decision recorded through an intervening custom entry", () => {
    // pi-llm-wiki's session notice sits between prompt and gate record on a
    // first turn. A custom entry is not an agent message, so this is not a
    // displacement.
    const withNotice: RoleAttributableEntry[] = [
      msg("u1", "user", null),
      {
        content: "notice",
        customType: "wiki-session-notice",
        id: "n1",
        parentId: "u1",
        role: undefined,
        type: "custom_message",
      },
      gate("g1-1", "n1", 1),
    ];

    expect(evaluations(jevGateTextByUserMessageId(withNotice).get("u1"))).toEqual([1]);
  });

  it("drops a displaced decision whose turn has no prompt yet", () => {
    // Mid-turn read: the opening decision exists but the prompt it governs is
    // not persisted. Parking it on the previous prompt is the leak being fixed.
    const pending: RoleAttributableEntry[] = [
      msg("u1", "user", null),
      msg("a1", "assistant", "u1"),
      gate("g2-1", "a1", 1),
    ];

    expect(jevGateTextByUserMessageId(pending).size).toBe(0);
  });

  it("attributes every mid-turn re-evaluation to the prompt that started the turn", () => {
    const longTurn: RoleAttributableEntry[] = [
      msg("u1", "user", null),
      msg("a1", "assistant", "u1"),
      msg("t1", "toolResult", "a1"),
      gate("g2", "t1", 2),
      msg("t2", "toolResult", "t1"),
      gate("g3", "t2", 3),
      msg("t3", "toolResult", "t2"),
      gate("g4", "t3", 4),
    ];

    expect(evaluations(jevGateTextByUserMessageId(longTurn).get("u1"))).toEqual([2, 3, 4]);
  });

  it("keeps an unparseable record on the turn it was found in", () => {
    // Its `evaluation` is unknown, so it cannot be recognised as displaced.
    // Re-keying on a guess would be worse than leaving it; the reader drops it
    // when parsing for display.
    const malformed: RoleAttributableEntry[] = [
      msg("u1", "user", null),
      msg("a1", "assistant", "u1"),
      {
        content: "not json",
        customType: JEV_GATE_CUSTOM_TYPE,
        id: "g1",
        parentId: "a1",
        role: undefined,
        type: "custom_message",
      },
    ];

    expect(jevGateTextByUserMessageId(malformed).get("u1")).toEqual(["not json"]);
  });

  it("terminates on a parent cycle rather than hanging the render", () => {
    const cyclic: RoleAttributableEntry[] = [
      msg("m1", "assistant", "m2"),
      msg("m2", "assistant", "m1"),
      gate("g1", "m1", 2),
    ];

    expect(jevGateTextByUserMessageId(cyclic).size).toBe(0);
  });

  it("ignores an entry with no usable text", () => {
    const empty: RoleAttributableEntry[] = [
      msg("u1", "user", null),
      { ...gate("g1", "u1", 2), content: "   " },
      { ...gate("g2", "u1", 2), content: { not: "a string" } },
    ];

    expect(jevGateTextByUserMessageId(empty).size).toBe(0);
  });
});
