/**
 * The full transcript of one workflow subagent, read back off disk.
 *
 * A run file's per-agent `history` is a live tail, not a log: it is rebuilt
 * from `session.messages` on every emit and fitted to 40 entries / 20k chars
 * (agent-history.ts). For a short agent that is the whole run; for a long one
 * it is whatever happened to be in the window when the last emit fired. A
 * 35-minute agent in this repository's own history left 39 entries covering
 * its last 80 seconds, and reading the same run file twice gave two
 * non-overlapping accounts of what it had done.
 *
 * Since f20943d every subagent also writes a real pi session file next to the
 * main session's, so the complete record exists. This module is the other half
 * of that commit: finding it again.
 *
 * WHY A SCAN, NOT A RECORDED PATH. The obvious design is to store the path on
 * the agent's persisted state when the session manager is built. That is O(1),
 * and it is the right thing to add if this ever gets slow. It is not what this
 * does, for two reasons: the run file's agent state is written by the workflow
 * extension, so threading a path there means a new callback through agent.ts,
 * workflow.ts and workflow-manager.ts; and a recorded path helps no transcript
 * already on disk, which is all of them today. The `session_info` name that
 * agent.ts already writes — `workflow:<runId> <label>` — is a unique key (agent
 * labels are enforced unique within a run), so the linkage is present and only
 * needs reading.
 *
 * The scan is bounded: one readdir, then the first 16 KB of each `.jsonl`,
 * stopping at the first match. `session_info` is the fourth line pi writes, so
 * no transcript is read past its header, and a main-session file simply never
 * matches.
 */

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import {
  compactAgentHistory,
  type AgentHistoryEntry,
} from "./extensions/dynamic-workflows/src/agent-history.ts";
import { PI_SESSION_DIR } from "./runtime-config";

/**
 * Bounds for a transcript rendered as agent detail.
 *
 * Generous rather than absent. The point of reading the transcript at all is
 * that the run file's 40/20k window loses the shape of a long run, so these
 * have to be far enough above it to be a different answer — but a transcript
 * can be several megabytes, and this ends up in a server-rendered page, so
 * "no limit" would trade a truncated record for an unbounded response.
 */
const TRANSCRIPT_HISTORY_LIMITS = {
  maxEntries: 2000,
  maxTextChars: 20_000,
  maxTotalChars: 1_000_000,
} as const;

/** Bytes of a transcript read when looking for its `session_info` header. */
const HEADER_PROBE_BYTES = 16_384;

/** The transcript entry fields this module reads. Pi writes many more. */
type TranscriptEntry = {
  type?: unknown;
  message?: unknown;
  summary?: unknown;
  tokensBefore?: unknown;
  timestamp?: unknown;
};

/** Transcript entries carry ISO timestamps; history entries carry epoch ms. */
function epochFromIso(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * The `session_info` name agent.ts records on every persisted subagent
 * session. Exported so a test pins the format against the producer rather
 * than restating it.
 */
export function subagentSessionName(runId: string, label: string): string {
  return `workflow:${runId} ${label}`;
}

/**
 * Resolved transcript paths. Transcripts never move, so a hit is permanent.
 * Keyed by directory as well as session name: the directory is a constant in
 * production but not under test, and a key that ignored it would answer a
 * lookup in one directory with a path found in another.
 */
const pathCache = new Map<string, string>();

function readHead(path: string): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(HEADER_PROBE_BYTES);
    const bytesRead = readSync(fd, buffer, 0, HEADER_PROBE_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** The `session_info` name in a transcript's header, if it declares one. */
function sessionNameOf(path: string): string | null {
  let head: string;
  try {
    head = readHead(path);
  } catch {
    return null;
  }

  for (const line of head.split("\n")) {
    if (!line.trim()) continue;
    let entry: { type?: unknown; name?: unknown };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      // The final line of a 16 KB probe is normally cut mid-object. Anything
      // before it parsed, and session_info comes before the first message.
      break;
    }
    if (entry.type === "session_info" && typeof entry.name === "string") {
      return entry.name;
    }
  }
  return null;
}

/**
 * Path of the transcript for one agent of one run, or null when the run
 * predates persistence or the agent's session was in-memory.
 */
export function findAgentTranscript(
  runId: string,
  label: string,
  sessionDir: string = PI_SESSION_DIR,
): string | null {
  const wanted = subagentSessionName(runId, label);
  const cacheKey = `${sessionDir}\u0000${wanted}`;

  const cached = pathCache.get(cacheKey);
  if (cached && existsSync(cached)) return cached;

  let files: string[];
  try {
    files = readdirSync(sessionDir);
  } catch {
    return null;
  }

  for (const file of files) {
    // Subagent transcripts are written under pi's own `<timestamp>_<id>.jsonl`
    // naming, so the main session's `<uuid>.jsonl` and the `.spans.jsonl`
    // sidecars beside it are scanned too. They carry no session_info name and
    // cost one 16 KB read each.
    if (!file.endsWith(".jsonl")) continue;
    const path = join(sessionDir, file);
    if (sessionNameOf(path) !== wanted) continue;
    pathCache.set(cacheKey, path);
    return path;
  }

  return null;
}

/**
 * Parse a persisted subagent transcript into the same entry shape the run
 * file's `history` uses.
 *
 * The mapping is compactAgentHistory's, not a second implementation of it: a
 * transcript's `message` entries are the very objects that function already
 * reads off a live session, so the only difference between this and the tail
 * the run file holds is the limits applied.
 */
export function readAgentTranscript(path: string): AgentHistoryEntry[] | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }

  const messages: unknown[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line) as TranscriptEntry;
    } catch {
      // A transcript is appended to while the agent runs, so the last line of
      // a file read mid-write is legitimately partial. Skip it and keep the
      // entries that did parse rather than discarding the whole record.
      continue;
    }

    if (entry.type === "message" && entry.message) {
      messages.push(entry.message);
      continue;
    }

    // A compaction is where the agent stopped being able to see what came
    // before it. The transcript keeps both sides, so this marker is the only
    // thing distinguishing "the agent read this and moved on" from "the agent
    // never saw this again" — normalised into a shape compactAgentHistory
    // understands so it keeps its place in the sequence.
    if (entry.type === "compaction") {
      messages.push({
        role: "compaction",
        summary: entry.summary,
        tokensBefore: entry.tokensBefore,
        timestamp: epochFromIso(entry.timestamp),
      });
    }
  }

  if (messages.length === 0) return null;
  return compactAgentHistory(messages, TRANSCRIPT_HISTORY_LIMITS);
}

/** Full history for an agent, or null when no transcript was persisted. */
export function readAgentHistoryFromTranscript(
  runId: string,
  label: string,
  sessionDir: string = PI_SESSION_DIR,
): AgentHistoryEntry[] | null {
  const path = findAgentTranscript(runId, label, sessionDir);
  return path ? readAgentTranscript(path) : null;
}
