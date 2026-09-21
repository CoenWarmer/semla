/**
 * Both shared attribution walks, and the difference between them.
 *
 * The bug this file exists for: the Jev gate wrote its decisions correctly and
 * the badge was rendered correctly, and the icon still never appeared, because
 * a mid-turn decision was attributed to the `toolResult` that triggered it.
 * That id is real, so nothing failed — the record just landed on an entry the
 * conversation has no badge slot on. Nothing caught it, so the shape that
 * causes it ("re-evaluation after a tool result") is the first case below.
 *
 * The gate no longer uses `customEntryTextByUserMessageId` directly — it needs
 * a further forward re-key that depends on parsing the record, which lives in
 * `jev-gate-attribution.ts` and is tested there. The generic walks are still
 * exercised here with a gate-shaped tree, because that tree is the realistic
 * hard case for them.
 */
import { describe, expect, it } from "vitest";

import {
  customEntryTextByMessageId,
  customEntryTextByUserMessageId,
  firstCustomEntryByMessageId,
  type RoleAttributableEntry,
} from "./custom-entry-attribution.ts";

const GATE = "jev-gate-decision";
const RECALL = "wiki-recall-context";

const msg = (
  id: string,
  role: string,
  parentId: string | null,
): RoleAttributableEntry => ({ id, parentId, role, type: "message" });

const custom = (
  id: string,
  customType: string,
  parentId: string | null,
  content: unknown = `${customType}-payload`,
): RoleAttributableEntry => ({
  content,
  customType,
  id,
  parentId,
  role: undefined,
  type: "custom_message",
});

/**
 * The turn shape observed in a real session on 2026-09-21: one decision before
 * the agent speaks, then one after each tool result it acts on.
 */
const midTurnSession: RoleAttributableEntry[] = [
  msg("u1", "user", null),
  custom("n1", "wiki-session-notice", "u1"),
  custom("r1", RECALL, "n1"),
  msg("a1", "assistant", "r1"),
  custom("g1", GATE, "a1", "decision-1"),
  msg("t1", "toolResult", "a1"),
  custom("g2", GATE, "t1", "decision-2"),
  msg("t2", "toolResult", "t1"),
  custom("g3", GATE, "t2", "decision-3"),
  msg("a2", "assistant", "t2"),
];

describe("customEntryTextByUserMessageId", () => {
  it("collapses every entry in a turn onto the user message that started it", () => {
    const byUser = customEntryTextByUserMessageId(midTurnSession, GATE);

    expect([...byUser.keys()]).toEqual(["u1"]);
    expect(byUser.get("u1")).toEqual(["decision-1", "decision-2", "decision-3"]);
  });

  it("is the walk the nearest-message one gets wrong", () => {
    // Not a redundant assertion of the old behaviour: it is the regression
    // itself. Two of three decisions attach to `toolResult` entries, which is
    // why the badge never rendered, and it is silent because these ids exist.
    const byMessage = customEntryTextByMessageId(midTurnSession, GATE);

    expect([...byMessage.keys()].sort()).toEqual(["a1", "t1", "t2"]);
    expect(byMessage.has("u1")).toBe(false);
  });

  it("keeps each turn's entries on its own user message", () => {
    const twoTurns: RoleAttributableEntry[] = [
      ...midTurnSession,
      msg("u2", "user", "a2"),
      msg("a3", "assistant", "u2"),
      custom("g4", GATE, "a3", "turn-2-decision"),
    ];

    const byUser = customEntryTextByUserMessageId(twoTurns, GATE);

    // The walk climbs back through `a3` → `u2` and stops. Reaching `u1` would
    // mean a turn absorbing the next turn's decisions.
    expect(byUser.get("u2")).toEqual(["turn-2-decision"]);
    expect(byUser.get("u1")).toEqual(["decision-1", "decision-2", "decision-3"]);
  });

  it("drops a record whose ancestry holds no user message", () => {
    // A branch root, or a truncated file: attributing to nothing is correct,
    // because there is no prompt to hang the badge beside.
    const orphaned = [msg("a1", "assistant", null), custom("g1", GATE, "a1")];

    expect(customEntryTextByUserMessageId(orphaned, GATE).size).toBe(0);
  });

  it("terminates on a parent cycle rather than hanging the render", () => {
    const cyclic: RoleAttributableEntry[] = [
      msg("m1", "assistant", "m2"),
      msg("m2", "assistant", "m1"),
      custom("g1", GATE, "m1"),
    ];

    expect(customEntryTextByUserMessageId(cyclic, GATE).size).toBe(0);
  });

  it("ignores an entry with no usable text", () => {
    const empty: RoleAttributableEntry[] = [
      msg("u1", "user", null),
      custom("g1", GATE, "u1", "   "),
      custom("g2", GATE, "u1", { not: "a string" }),
    ];

    expect(customEntryTextByUserMessageId(empty, GATE).size).toBe(0);
  });
});

describe("customEntryTextByMessageId", () => {
  it("still climbs past an intervening session notice for the wiki's recall", () => {
    // The original subtlety, unchanged by the user-scoped variant: on a first
    // turn the recall's direct parent is the notice, not the prompt.
    const byMessage = firstCustomEntryByMessageId(midTurnSession, RECALL);

    expect(byMessage.get("u1")).toBe("wiki-recall-context-payload");
  });
});
