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
import {
  firstCustomEntryByMessageId,
  type RoleAttributableEntry,
} from "@/lib/pi/session/custom-entry-attribution";
import { jevGateTextByUserMessageId } from "@/lib/pi/session/jev-gate-attribution";
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
  /**
   * Jev gate decisions recorded during this message's turn, in order, as raw
   * JSON. A list because the gate re-evaluates mid-turn, so a long turn
   * legitimately has several and keeping one would misreport what the agent
   * could see when it acted.
   */
  jevGate?: string[];
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
 * A session entry's message role, or undefined where it has none.
 *
 * `message` is `unknown` on this interface and stays that way — the file is
 * read from disk and may have been written by an older Semla or edited by
 * hand, so the shape is narrowed at the point of use rather than asserted for
 * the whole transcript.
 */
function entryRole(entry: SessionFileEntry): string | undefined {
  const role = (entry.message as { role?: unknown } | undefined)?.role;
  return typeof role === "string" ? role : undefined;
}

/**
 * The same entries with their roles projected, for the user-scoped walk.
 *
 * A separate pass rather than a field on `SessionFileEntry`: that interface
 * mirrors a line of the file exactly, and a `role` on it would claim the file
 * stores one at the top level, which it does not.
 */
function withRoles(
  entries: readonly SessionFileEntry[],
): Array<SessionFileEntry & RoleAttributableEntry> {
  return entries.map((entry) => ({ ...entry, role: entryRole(entry) }));
}

/**
 * pi-llm-wiki's `before_agent_start` hook appends the recall context as a
 * `custom_message` entry parented to the user message that triggered it —
 * the model sees it as the next turn of context, and the assistant's own
 * reply is parented to *this* entry rather than to the user message.
 *
 * The walk that attributes it to the right message lives in
 * `custom-entry-attribution.ts`, because the Jev gate's own record needs the
 * identical treatment and this file and `transcript.ts` had a copy each
 * already. The subtlety it encodes — that an intervening `wiki-session-notice`
 * makes the recall entry's direct parent the wrong answer on a session's first
 * turn — is documented there.
 *
 * `custom_message` entries are otherwise dropped by the `type === "message"`
 * filters below: every other `customType` an extension might send is
 * intentionally excluded, and only a record of what informed a response is
 * surfaced.
 */
function wikiRecallByParentId(
  entries: readonly SessionFileEntry[],
): Map<string, string> {
  return firstCustomEntryByMessageId(entries, WIKI_RECALL_CUSTOM_TYPE);
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
  // Gate-aware rather than the shared user-scoped walk: a mid-turn
  // re-evaluation hangs off the `toolResult` that triggered it, and a
  // turn-start decision hangs off the *previous* turn's tail. See
  // jev-gate-attribution.ts.
  const jevGate = jevGateTextByUserMessageId(withRoles(entries));

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
      const gate = entry.id ? jevGate.get(entry.id) : undefined;

      return {
        created_at: entry.timestamp ?? "",
        id: entry.id as string,
        payload: { entry },
        ...(earlier.length > 0 ? { superseded: earlier } : {}),
        ...(recall ? { wikiRecall: recall } : {}),
        ...(gate?.length ? { jevGate: gate } : {}),
      };
    });
}
