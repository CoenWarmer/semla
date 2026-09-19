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
  const byId = new Map<string, T>();
  for (const entry of entries) {
    if (entry.id) byId.set(entry.id, entry);
  }

  const nearestMessageAncestor = (start: T): string | undefined => {
    const seen = new Set<string>();
    let current: T | undefined = start;
    while (current) {
      if (current.type === "message") return current.id;
      const id = current.id;
      if (id) {
        if (seen.has(id)) return undefined;
        seen.add(id);
      }
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return undefined;
  };

  const byParent = new Map<string, string[]>();
  for (const entry of entries) {
    if (entry.type !== "custom_message") continue;
    if (entry.customType !== customType) continue;
    if (!entry.parentId) continue;
    const parentEntry = byId.get(entry.parentId);
    const messageId = parentEntry && nearestMessageAncestor(parentEntry);
    if (!messageId) continue;
    const text = typeof entry.content === "string" ? entry.content : "";
    if (!text.trim()) continue;
    const existing = byParent.get(messageId);
    if (existing) existing.push(text);
    else byParent.set(messageId, [text]);
  }
  return byParent;
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
