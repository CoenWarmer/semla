/**
 * Read a session's transcript from disk.
 *
 * Pi appends every entry to `<PI_SESSION_DIR>/<sessionId>.jsonl` as it happens,
 * so the file is a complete record that exists before Postgres has been told
 * anything. Postgres held the copy the UI read, which meant the transcript was
 * only as available as the database: an outage emptied the conversation view of
 * a session whose history was sitting on disk the whole time.
 *
 * Each line is exactly the object stored as `payload.entry` in
 * `pi_session_entries`, so both sources reduce to the same shape and the
 * transform over them stays one implementation.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { PI_SESSION_DIR } from "@/lib/pi/runtime/runtime-config";
import { activePath, supersededSiblings } from "@/lib/pi/session/session-path";
import { resolveLeafOverride } from "@/lib/pi/session/session-leaf";
import { WIKI_RECALL_CUSTOM_TYPE } from "@/lib/pi/wiki/wiki-recall-message";

/** The row shape getTranscript consumes, from either source. */
export interface TranscriptRow {
  created_at: string;
  id: string;
  payload: {
    entry: {
      id?: string;
      message?: unknown;
      /** Parent in the session tree. Carried so superseded versions are findable. */
      parentId?: string | null;
      timestamp?: string;
      type?: string;
    };
  };
  /**
   * Earlier versions of this entry — siblings it was branched away from, oldest
   * first. Present only where a prompt was edited.
   */
  superseded?: Array<{ message?: unknown; timestamp?: string }>;
  /**
   * The wiki auto-recall content injected right after this message, when the
   * turn it started had any. See {@link wikiRecallByParentId}.
   */
  wikiRecall?: string;
}

export interface SessionFileEntry {
  id?: string;
  message?: unknown;
  parentId?: string | null;
  timestamp?: string;
  type?: string;
  /** Present on a `custom_message` entry — the extension's own identifier. */
  customType?: string;
  /** Present on a `custom_message` entry. */
  content?: unknown;
}

/**
 * pi-llm-wiki's `before_agent_start` hook appends the recall context as a
 * `custom_message` entry parented to the user message that triggered it —
 * the model sees it as the next turn of context, and the assistant's own
 * reply is parented to *this* entry rather than to the user message.
 *
 * "Parented to", not "parented directly to": on a session's first turn, pi's
 * own session-start hook has already inserted its own `wiki-session-notice`
 * custom_message between the user message and this one —
 * `user → wiki-session-notice → wiki-recall-context → assistant`. A recall
 * entry's immediate `parentId` is then the notice, not the user message, so
 * matching only the direct parent finds nothing on exactly the turn every
 * "new session" test exercises — recall showed on the live stream (which is
 * driven by message order, not the parent chain) and vanished the moment the
 * turn ended and the persisted transcript, built from this chain, replaced
 * it. Walking up through intervening non-message ancestors to the nearest
 * real message is what the assistant reply's own parenting already implies
 * the tree means: everything between one message and the next belongs to the
 * turn that message started.
 *
 * `custom_message` entries are otherwise dropped by the `type === "message"`
 * filters below — every other `customType` pi-llm-wiki or another extension
 * might send is intentionally excluded here; only the recall context is a
 * fact about what informed a response that traceability requires surfacing.
 */
function wikiRecallByParentId(
  entries: readonly SessionFileEntry[],
): Map<string, string> {
  const byId = new Map<string, SessionFileEntry>();
  for (const entry of entries) {
    if (entry.id) byId.set(entry.id, entry);
  }

  // The nearest ancestor that is itself a real message — skipping any
  // custom_message (or other non-message entry) in between, and refusing to
  // loop forever on a malformed parent cycle.
  const nearestMessageAncestor = (start: SessionFileEntry): string | undefined => {
    const seen = new Set<string>();
    let current: SessionFileEntry | undefined = start;
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

  const byParent = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type !== "custom_message") continue;
    if (entry.customType !== WIKI_RECALL_CUSTOM_TYPE) continue;
    if (!entry.parentId) continue;
    const parentEntry = byId.get(entry.parentId);
    const messageId = parentEntry && nearestMessageAncestor(parentEntry);
    if (!messageId) continue;
    const text = typeof entry.content === "string" ? entry.content : "";
    if (text.trim()) byParent.set(messageId, text);
  }
  return byParent;
}

export function sessionFilePath(semlaSessionId: string, dir = PI_SESSION_DIR): string {
  return join(dir, `${semlaSessionId}.jsonl`);
}

/**
 * Message entries on the session's live path, or null when there is no file.
 *
 * Null rather than an empty array on purpose: "no file" means fall back to
 * Postgres, while a file containing no messages is a real, empty transcript.
 * Unparseable lines are skipped rather than failing the read — a truncated
 * final line loses one entry, not the conversation.
 *
 * The file is a tree, so the lines are walked (see session-path.ts) before being
 * filtered to messages, never after. Filtering first would cut the chain
 * wherever a non-message entry — a branch summary, say — sits between two
 * messages, and the walk would stop early at a gap of its own making.
 */
/**
 * Every entry in the file, tree structure intact — abandoned branches
 * included, unlike `readSessionEntries` which walks down to the live
 * conversation. For anything that needs to see the *shape* of the tree rather
 * than the one path through it: session-turn-graph.ts is the only caller so
 * far.
 *
 * Null for exactly the cases `readSessionEntries` treats as null: no file, or
 * an empty one. An empty array means a real file holding only its header.
 */
export function readAllSessionEntries(
  semlaSessionId: string,
  dir = PI_SESSION_DIR,
): SessionFileEntry[] | null {
  return parseSessionFile(sessionFilePath(semlaSessionId, dir));
}

/**
 * The same parse, for a file addressed by path rather than by session id.
 *
 * Workflow subagents write real pi session files under pi's own
 * `<timestamp>_<id>.jsonl` naming, so they are readable by exactly this parser
 * but not nameable by session id. See workflow-agent-transcript.ts.
 */
export function readSessionEntriesFromPath(
  path: string,
): SessionFileEntry[] | null {
  return parseSessionFile(path);
}

function parseSessionFile(path: string): SessionFileEntry[] | null {
  try {
    if (statSync(path).size === 0) return null;
  } catch {
    return null;
  }

  const entries: SessionFileEntry[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;

    let entry: SessionFileEntry;
    try {
      entry = JSON.parse(line) as SessionFileEntry;
    } catch {
      continue;
    }

    // The header describes the session rather than belonging to the tree, which
    // is also how Pi's own getEntries() treats it.
    if (entry.type === "session" || !entry.id) continue;

    entries.push(entry);
  }

  return entries;
}

export function readSessionEntries(
  semlaSessionId: string,
  dir = PI_SESSION_DIR,
  leafId?: string | null,
): TranscriptRow[] | null {
  const entries = parseSessionFile(sessionFilePath(semlaSessionId, dir));
  if (!entries) return null;

  const resolvedLeaf = resolveLeafOverride(entries, leafId);
  const superseded = supersededSiblings(entries, resolvedLeaf);
  const wikiRecall = wikiRecallByParentId(entries);

  return activePath(entries, resolvedLeaf)
    .filter((entry) => entry.type === "message")
    .map((entry) => {
      // Only message siblings: a prompt branched away from may have a whole
      // abandoned subtree under it, and "what did this say before" wants the
      // prompt, not the replies it drew.
      const earlier = (superseded.get(entry.id as string) ?? []).filter(
        (sibling) => sibling.type === "message",
      );
      const recall = entry.id ? wikiRecall.get(entry.id) : undefined;

      return {
        created_at: entry.timestamp ?? "",
        id: entry.id as string,
        payload: { entry },
        ...(earlier.length > 0 ? { superseded: earlier } : {}),
        ...(recall ? { wikiRecall: recall } : {}),
      };
    });
}
