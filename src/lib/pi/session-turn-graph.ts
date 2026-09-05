/**
 * Collapsing a session's entry tree to the unit people actually think in: the
 * turn — a user message and everything the agent did in reply, entries and
 * all.
 *
 * One node per entry is unusable; docs/plans/branching-sessions.md §4 records
 * a session with 1,013 entries. This walks the *whole* tree (not just the
 * live path — see session-path.ts for that), groups every entry under the
 * nearest user message above it, and returns one node per user message with
 * the rest folded into its `entryCount`.
 *
 * A node with more than one child is a fork point: the place a branch was
 * taken. That property falls out of the tree shape and does not need marking
 * specially — the layout (elk, in session-turn-layout.ts) draws diverging
 * edges from it on its own.
 *
 * Not built on session-steps.ts's `groupConversation`, even though
 * docs/plans/branching-sessions.md §4 says to check it first. That function
 * solves a different problem: it folds *consecutive silent assistant turns on
 * the live path* into a strip for display, so a run of tool calls does not
 * draw as empty bubbles. This needs turns bounded by *every* user message
 * across the *whole* tree, abandoned branches included — a different
 * boundary over a different set of entries, and bending one to answer the
 * other's question would have cost more than writing this.
 */
import type { SessionFileEntry } from "@/lib/pi/session-file";
import { activePath } from "@/lib/pi/session-path";
import { getMessageText, type PiMessage } from "@/lib/pi/transcript";

/** One turn: a user message (or the session's start) and its reply. */
export type TurnNode = {
  /** The entry id this turn starts at. Synthetic for entries before any user message. */
  id: string;
  /** Null for the synthetic root — a session that opens with something other than a message. */
  parentId: string | null;
  /** First line of the user's prompt, for the node's label. Null for the synthetic root. */
  promptText: string | null;
  /** Every entry folded into this turn, including the head itself. */
  entryCount: number;
  /** Tool calls the assistant made in reply, summed across every reply this turn folds in. */
  toolCallCount: number;
  /**
   * This turn's own spend \u2014 the same fields session-usage-store.ts's
   * sumEntryUsage sums for a whole session, scoped here to the entries this
   * one turn folds in, so a node's cost is what that turn cost rather than a
   * running total that grows meaningless to compare node to node.
   */
  tokens: number;
  cost: number;
  createdAt: string;
  /** On the path the session's default leaf resolves to \u2014 session-path.ts's rule, no override. */
  isLive: boolean;
  /** More than one child: a branch was taken here. */
  isFork: boolean;
};

/** A message entry as far as tool-call counting and usage summing care. */
type UsageBearingMessage = {
  content?: unknown;
  role?: unknown;
  usage?: { cost?: { total?: number } | null; totalTokens?: number } | null;
};

/** How a single entry contributes to its turn's tool-call count and spend. */
function entryContribution(
  entry: SessionFileEntry,
): { cost: number; toolCallCount: number; tokens: number } {
  const message = entry.message as UsageBearingMessage | null | undefined;
  if (!isRecord(message)) return { cost: 0, toolCallCount: 0, tokens: 0 };

  const toolCallCount = Array.isArray(message.content)
    ? message.content.filter(
        (part) => isRecord(part) && part.type === "toolCall",
      ).length
    : 0;

  // Usage lives on the assistant message, the same restriction
  // sumEntryUsage applies \u2014 a user entry carries none, and a role that
  // later gains one should not be double-counted here either.
  if (message.role !== "assistant" || !message.usage) {
    return { cost: 0, toolCallCount, tokens: 0 };
  }

  return {
    cost: message.usage.cost?.total ?? 0,
    toolCallCount,
    tokens: message.usage.totalTokens ?? 0,
  };
}

export type TurnGraph = {
  nodes: TurnNode[];
  /** Parent id \u2192 child id. A node with no entry here is a leaf turn. */
  edges: Array<{ from: string; to: string }>;
  /** True when the file held more entries than were resolvable into the tree at all (a malformed file). Currently always false; kept so a future caller does not need a shape change to report it. */
  truncated: boolean;
};

/** Synthetic id for entries preceding the first user message, if any exist. */
const ROOT_TURN_ID = "\u2039root\u203a";

const isUserMessage = (entry: SessionFileEntry): boolean =>
  entry.type === "message" &&
  isRecord(entry.message) &&
  (entry.message as { role?: unknown }).role === "user";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** First non-empty line of a prompt, for a node label short enough to fit a box. */
function firstLine(text: string): string {
  const line = text.split("\n").find((candidate) => candidate.trim().length > 0);
  return (line ?? text).trim();
}

/**
 * Build the turn graph for a session's full entry list \u2014 pass
 * `readAllSessionEntries()`'s result, not `readSessionEntries()`'s, or every
 * abandoned branch disappears before this ever sees it.
 */
export function buildTurnGraph(entries: readonly SessionFileEntry[]): TurnGraph {
  if (entries.length === 0) {
    return { edges: [], nodes: [], truncated: false };
  }

  const byId = new Map<string, SessionFileEntry>();
  for (const entry of entries) {
    if (entry.id) byId.set(entry.id, entry);
  }

  // The nearest turn-head ancestor of every entry, inclusive of itself when
  // the entry is itself a head. Computed once so both the entry count and the
  // parent-turn lookup below read the same answer.
  //
  // Walked iteratively rather than recursively, with a `seen` guard: a
  // malformed file can contain a parent cycle (session-path.ts's activePath
  // has the same guard for the same reason), and unwinding a recursive call
  // for each entry would turn that into a stack overflow rather than a
  // tolerated oddity.
  const headOf = new Map<string, string>();
  const resolveHead = (start: SessionFileEntry): string => {
    const startId = start.id;
    if (startId && headOf.has(startId)) return headOf.get(startId) as string;

    const chain: string[] = [];
    const seen = new Set<string>();
    let current: SessionFileEntry | undefined = start;

    while (current) {
      const id = current.id;
      if (id) {
        if (headOf.has(id)) {
          const head = headOf.get(id) as string;
          for (const chainId of chain) headOf.set(chainId, head);
          return head;
        }
        if (seen.has(id)) break;
        seen.add(id);
      }

      if (isUserMessage(current)) {
        const head = id as string;
        for (const chainId of chain) headOf.set(chainId, head);
        if (id) headOf.set(id, head);
        return head;
      }

      if (id) chain.push(id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }

    const head = ROOT_TURN_ID;
    for (const chainId of chain) headOf.set(chainId, head);
    return head;
  };

  const entryCounts = new Map<string, number>();
  const toolCallCounts = new Map<string, number>();
  const tokenTotals = new Map<string, number>();
  const costTotals = new Map<string, number>();
  const heads = new Map<string, SessionFileEntry>();
  let sawRootEntries = false;

  for (const entry of entries) {
    const head = resolveHead(entry);
    entryCounts.set(head, (entryCounts.get(head) ?? 0) + 1);

    const contribution = entryContribution(entry);
    if (contribution.toolCallCount > 0) {
      toolCallCounts.set(
        head,
        (toolCallCounts.get(head) ?? 0) + contribution.toolCallCount,
      );
    }
    if (contribution.tokens > 0) {
      tokenTotals.set(head, (tokenTotals.get(head) ?? 0) + contribution.tokens);
    }
    if (contribution.cost > 0) {
      costTotals.set(head, (costTotals.get(head) ?? 0) + contribution.cost);
    }

    if (head === ROOT_TURN_ID) sawRootEntries = true;
    else if (!heads.has(head)) heads.set(head, entry);
  }

  // The parent *turn* of each head: walk its own parent chain to the nearest
  // ancestor that is itself a head, skipping the non-message entries between
  // them \u2014 a compaction or a tool result is not a turn boundary.
  const parentTurnOf = (head: SessionFileEntry): string | null => {
    const parentId = head.parentId;
    if (!parentId) return sawRootEntries ? ROOT_TURN_ID : null;
    const parentEntry = byId.get(parentId);
    if (!parentEntry) return sawRootEntries ? ROOT_TURN_ID : null;
    return resolveHead(parentEntry);
  };

  // SessionFileEntry structurally satisfies PathEntry (id + parentId), so no
  // cast is needed — activePath's generic infers this entry shape directly.
  const livePath = new Set(
    activePath(entries)
      .map((entry) => entry.id)
      .filter((id): id is string => Boolean(id)),
  );

  const edges: Array<{ from: string; to: string }> = [];
  const childCounts = new Map<string, number>();

  const nodes: TurnNode[] = [];

  if (sawRootEntries) {
    nodes.push({
      cost: costTotals.get(ROOT_TURN_ID) ?? 0,
      createdAt: entries[0]?.timestamp ?? "",
      entryCount: entryCounts.get(ROOT_TURN_ID) ?? 0,
      id: ROOT_TURN_ID,
      isFork: false, // filled in below once every edge is known
      isLive: true, // the root of every path is always live
      parentId: null,
      promptText: null,
      tokens: tokenTotals.get(ROOT_TURN_ID) ?? 0,
      toolCallCount: toolCallCounts.get(ROOT_TURN_ID) ?? 0,
    });
  }

  for (const [headId, head] of heads) {
    const parentTurn = parentTurnOf(head);
    if (parentTurn) {
      edges.push({ from: parentTurn, to: headId });
      childCounts.set(parentTurn, (childCounts.get(parentTurn) ?? 0) + 1);
    }

    nodes.push({
      cost: costTotals.get(headId) ?? 0,
      createdAt: head.timestamp ?? "",
      entryCount: entryCounts.get(headId) ?? 1,
      id: headId,
      isFork: false,
      isLive: head.id ? livePath.has(head.id) : false,
      parentId: parentTurn,
      promptText: firstLine(getMessageText(head.message as PiMessage)),
      tokens: tokenTotals.get(headId) ?? 0,
      toolCallCount: toolCallCounts.get(headId) ?? 0,
    });
  }

  for (const node of nodes) {
    if ((childCounts.get(node.id) ?? 0) > 1) node.isFork = true;
  }

  return { edges, nodes, truncated: false };
}
