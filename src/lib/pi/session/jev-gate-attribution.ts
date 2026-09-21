/**
 * Attributing Jev gate decisions to the turn they actually governed.
 *
 * `customEntryTextByUserMessageId` in custom-entry-attribution.ts gets the
 * wiki's recall right and the gate's decisions *nearly* right, and the
 * remainder is why this module exists. Climbing to the nearest user message
 * assumes an entry was written during the turn it belongs to. A gate decision
 * breaks that assumption once per turn.
 *
 * The gate evaluates at `before_agent_start`, and the record it writes there
 * lands on the tree's leaf at that moment — which is the *previous* turn's
 * trailing `assistant` message, because the new prompt has not been appended
 * yet. Climbing from there walks back into the previous turn and stops at its
 * prompt. So every badge's list ended with one decision belonging to the turn
 * after it, and a turn with the gate switched off still showed a record: on
 * 2026-09-21 the prompt "in the spec I requested that an icon…" displayed one
 * decision for a turn during which the gate never ran. That is the observation
 * this module is built from, and `evaluation` ordering is the tell — a turn's
 * records read `[2, 3, …, 9, 1]`, the stray `1` being the next turn's opener.
 *
 * Two facts are needed to recognise a displaced record, and neither alone is
 * enough:
 *
 *  - it is a **turn-start** record, `evaluation === 1`. A mid-turn
 *    re-evaluation is parented to the tool result that triggered it and is
 *    already attributed correctly.
 *  - an `assistant` or `toolResult` message lies **between** it and the prompt
 *    the climb reached. A turn-start record written after the prompt was
 *    appended reaches it through nothing but custom entries, and must be left
 *    alone — a session's first turn has no previous assistant to be displaced
 *    onto, and moving it forward would break the case that already works.
 *
 * Both together mean "recorded at the start of the turn *following* the prompt
 * this climb found", and the fix is to hand it to the next prompt instead.
 *
 * Kept out of custom-entry-attribution.ts deliberately. That module is generic
 * over `customType` and reads an entry's text without interpreting it, which is
 * what lets the wiki and the gate share one tree walk. Recognising a turn-start
 * record means parsing the record, so a gate-specific concern lives in a
 * gate-specific module rather than pushing a JSON parse into the shared walk.
 */

import {
  JEV_GATE_CUSTOM_TYPE,
  parseJevGateRecord,
} from "@/lib/pi/extensions/jev-gate/gate-record";
import type { RoleAttributableEntry } from "@/lib/pi/session/custom-entry-attribution";

/** The first evaluation of a turn — the one written at `before_agent_start`. */
const TURN_START_EVALUATION = 1;

function isUserMessage(entry: RoleAttributableEntry): boolean {
  return entry.type === "message" && entry.role === "user";
}

/**
 * Whether an entry is a non-user message, i.e. an assistant reply or a tool
 * result. Its presence on the climb is what marks a turn-start record as
 * having been written before its own prompt existed.
 */
function isAgentMessage(entry: RoleAttributableEntry): boolean {
  return entry.type === "message" && entry.role !== "user";
}

interface ClimbResult {
  /** The prompt the climb reached, if any. */
  userMessageId: string | undefined;
  /** Whether an assistant or toolResult message was passed on the way. */
  viaAgentMessage: boolean;
}

/**
 * Climb to the nearest prompt, reporting whether an agent message was crossed.
 *
 * Bounded by a seen-set for the same reason the shared walk is: a malformed
 * parent cycle in a hand-edited session file must not hang a page render.
 */
function climbToPrompt(
  start: RoleAttributableEntry,
  byId: ReadonlyMap<string, RoleAttributableEntry>,
): ClimbResult {
  const seen = new Set<string>();
  let current: RoleAttributableEntry | undefined = start;
  let viaAgentMessage = false;

  while (current) {
    if (isUserMessage(current)) {
      return { userMessageId: current.id, viaAgentMessage };
    }
    if (isAgentMessage(current)) viaAgentMessage = true;

    const id = current.id;
    if (id) {
      if (seen.has(id)) break;
      seen.add(id);
    }
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  return { userMessageId: undefined, viaAgentMessage };
}

/**
 * Map prompt id to the raw text of each gate decision that governed its turn,
 * in file order.
 *
 * A list because the gate re-evaluates mid-turn, so a long turn legitimately
 * has several — keeping one would misreport what the agent could see when it
 * acted.
 *
 * A record whose turn has no prompt in `entries` is dropped rather than parked
 * on the previous one. That happens for the decision opening a turn whose
 * prompt has not been persisted yet, and showing it on the turn before would
 * reintroduce exactly the cross-turn leak this module removes.
 */
export function jevGateTextByUserMessageId<T extends RoleAttributableEntry>(
  entries: readonly T[],
): Map<string, string[]> {
  const byId = new Map<string, T>();
  for (const entry of entries) {
    if (entry.id) byId.set(entry.id, entry);
  }

  // File order, which is turn order: the successor of a displaced record's
  // prompt is the prompt whose turn actually opened with it.
  const promptOrder: string[] = [];
  const promptIndex = new Map<string, number>();
  for (const entry of entries) {
    if (!isUserMessage(entry) || !entry.id) continue;
    promptIndex.set(entry.id, promptOrder.length);
    promptOrder.push(entry.id);
  }

  const byPrompt = new Map<string, string[]>();

  for (const entry of entries) {
    if (entry.type !== "custom_message") continue;
    if (entry.customType !== JEV_GATE_CUSTOM_TYPE) continue;
    if (!entry.parentId) continue;

    const parent = byId.get(entry.parentId);
    if (!parent) continue;

    const text = typeof entry.content === "string" ? entry.content : "";
    if (!text.trim()) continue;

    const { userMessageId, viaAgentMessage } = climbToPrompt(parent, byId);
    if (!userMessageId) continue;

    // An unparseable record still belongs to the turn it was found in: it is
    // dropped later, when the reader parses it for display, rather than being
    // silently re-keyed here on a guess about its `evaluation`.
    const record = parseJevGateRecord(text);
    const displaced =
      viaAgentMessage && record?.evaluation === TURN_START_EVALUATION;

    let target = userMessageId;
    if (displaced) {
      const index = promptIndex.get(userMessageId);
      const next = index === undefined ? undefined : promptOrder[index + 1];
      if (!next) continue;
      target = next;
    }

    const existing = byPrompt.get(target);
    if (existing) existing.push(text);
    else byPrompt.set(target, [text]);
  }

  return byPrompt;
}
