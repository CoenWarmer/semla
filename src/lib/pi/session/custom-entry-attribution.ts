/**
 * Attributing an extension's `custom_message` entry to the message whose turn
 * it belongs to.
 *
 * Two readers need this — `session-file.ts` reading the `.jsonl` from disk and
 * `transcript.ts` reading rows from Postgres — and they had one copy each, with
 * the same comment explaining the same subtlety twice. Adding the Jev gate's
 * record would have made three, so the walk lives here once and both call it.
 *
 * The subtlety, worth keeping: an extension's entry is not necessarily a child
 * of the user message. On a session's first turn pi-llm-wiki's own session
 * notice sits in between (user → wiki-session-notice → wiki-recall-context →
 * assistant), so a direct `parentId` lookup attributes the recall to the notice
 * and the badge never appears. Everything between one message and the next
 * belongs to the turn that message started, which is also how the assistant
 * reply is parented, so the walk climbs through non-message ancestors to the
 * nearest real message — bounded by a seen-set, because a malformed parent
 * cycle in a session file should not hang a page render.
 *
 * That walk is not enough for every extension, which is the second subtlety
 * and the reason for the user-scoped variant below. "Nearest message" is the
 * right answer only for an entry emitted once, before the turn's first
 * assistant output — the wiki's recall. The Jev gate also re-evaluates
 * mid-turn, after a tool result, so its later entries have an `assistant` or
 * `toolResult` message as their immediate ancestor and stop there. Those ids
 * are real, so nothing errors; the records simply attach to entries the
 * conversation has no badge slot on, and the icon never renders. Only the user
 * message that opened the turn is a place a reader can be shown "here is what
 * the agent could do", and collapsing a turn's several decisions onto it is
 * also what `JevGateBadge`'s list-of-records popover is built to display.
 */

/** The minimum an entry must expose to be attributed. Both readers satisfy it. */
export interface AttributableEntry {
  id?: string;
  parentId?: string | null;
  type?: string;
  customType?: string;
  content?: unknown;
}

/**
 * An entry that also carries its message role, for the user-scoped walk.
 *
 * `role` is **required**, though its value may be `undefined` — a
 * `custom_message` has no role, and neither does a `model_change`. Optional
 * would have been the natural spelling and is the wrong one: `AttributableEntry`
 * is satisfied structurally, so a caller that simply forgot to project the
 * field would still compile and every role would read `undefined`. The walk
 * would then find no user message, attribute nothing, and render no badge —
 * which is the exact failure this variant exists to fix, arriving silently a
 * second time. Requiring the key makes forgetting it a type error.
 */
export interface RoleAttributableEntry extends AttributableEntry {
  role: string | undefined;
}

/**
 * Climb from `start` through ancestors to the first entry `accept` approves.
 *
 * Shared by both public walks so "everything between one message and the next
 * belongs to the turn that message started" is expressed once. The seen-set
 * bounds it: a malformed parent cycle in a hand-edited session file should not
 * hang a page render.
 */
function nearestAncestor<T extends AttributableEntry>(
  start: T,
  byId: ReadonlyMap<string, T>,
  accept: (entry: T) => boolean,
): string | undefined {
  const seen = new Set<string>();
  let current: T | undefined = start;
  while (current) {
    if (accept(current)) return current.id;
    const id = current.id;
    if (id) {
      if (seen.has(id)) return undefined;
      seen.add(id);
    }
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return undefined;
}

/**
 * Group each matching `custom_message`'s text under the id `attribute` returns
 * for its parent, preserving file order.
 */
function groupByAttributedParent<T extends AttributableEntry>(
  entries: readonly T[],
  customType: string,
  attribute: (parent: T, byId: ReadonlyMap<string, T>) => string | undefined,
): Map<string, string[]> {
  const byId = new Map<string, T>();
  for (const entry of entries) {
    if (entry.id) byId.set(entry.id, entry);
  }

  const byParent = new Map<string, string[]>();
  for (const entry of entries) {
    if (entry.type !== "custom_message") continue;
    if (entry.customType !== customType) continue;
    if (!entry.parentId) continue;
    const parentEntry = byId.get(entry.parentId);
    const messageId = parentEntry && attribute(parentEntry, byId);
    if (!messageId) continue;
    const text = typeof entry.content === "string" ? entry.content : "";
    if (!text.trim()) continue;
    const existing = byParent.get(messageId);
    if (existing) existing.push(text);
    else byParent.set(messageId, [text]);
  }
  return byParent;
}

/**
 * Map message id to the text of each matching `custom_message` entry in its
 * turn, in file order.
 *
 * A list rather than a single string because a turn can carry more than one —
 * the gate re-evaluates mid-turn, so a long turn legitimately has several
 * decisions, and keeping only the first or last would misreport what the agent
 * could see when it acted.
 */
export function customEntryTextByMessageId<T extends AttributableEntry>(
  entries: readonly T[],
  customType: string,
): Map<string, string[]> {
  return groupByAttributedParent(entries, customType, (parent, byId) =>
    nearestAncestor(parent, byId, (entry) => entry.type === "message"),
  );
}

/**
 * Map **user** message id to the text of each matching `custom_message` entry
 * in the turn that message started.
 *
 * For an extension whose entries can be emitted after the turn's first
 * assistant output — the Jev gate re-evaluating after a tool result. Climbing
 * only to the nearest message stops at that `assistant` or `toolResult` and
 * attributes the record somewhere nothing renders it; see the second subtlety
 * in this module's header.
 *
 * Every turn begins with a user message and an entry's ancestry runs back
 * through its own turn, so the first `user` ancestor is the one that started
 * it — the walk cannot reach into a previous turn without passing it.
 */
export function customEntryTextByUserMessageId<T extends RoleAttributableEntry>(
  entries: readonly T[],
  customType: string,
): Map<string, string[]> {
  return groupByAttributedParent(entries, customType, (parent, byId) =>
    nearestAncestor(
      parent,
      byId,
      (entry) => entry.type === "message" && entry.role === "user",
    ),
  );
}

/** The single-valued form, for a custom type that fires at most once a turn. */
export function firstCustomEntryByMessageId<T extends AttributableEntry>(
  entries: readonly T[],
  customType: string,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, texts] of customEntryTextByMessageId(entries, customType)) {
    if (texts[0]) out.set(id, texts[0]);
  }
  return out;
}
