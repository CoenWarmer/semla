/**
 * A session's token and cost totals, on disk.
 *
 * Disk is the primary source in Semla and Postgres is the backup, so this is
 * where the number the UI shows comes from. It was read out of the mirror,
 * which was both slower — a network round trip against a `readFileSync` — and
 * behind, because entries are persisted through a queue and the sidebar
 * therefore trailed a turn that had already finished.
 *
 * **Only the conversation half.** The workflow half is not stamped: it is read
 * from the run files, which `workflow-run-index.ts` maps to a session, and
 * which are authoritative where the `workflow_runs` snapshot column is not —
 * that column is kept current only for foreground runs.
 *
 * An earlier version stamped runs here too, on the belief that disk had no
 * session-to-run mapping at all. It has one; a *run file* simply carries no
 * session id, which is not the same thing. That stamp also built a total out
 * of snapshots persisted mid-run, which is the staleness the run files avoid:
 * one real run reported 9,052 tokens in its file against 5,361 in Postgres.
 *
 * Every write is best-effort. A total that failed to update is a wrong number
 * on a badge; a turn that failed because of one is a lost conversation.
 */

import {
  readSessionMeta,
  writeSessionMeta,
  type SessionMeta,
} from "@/lib/pi/session-meta";
import {
  EMPTY_USAGE_RECORD,
  type SessionUsage,
  type SessionUsageRecord,
} from "@/lib/session-usage";

/** A pi entry as the transcript holds it, in the shape usage lives in. */
type UsageBearingEntry = {
  message?: {
    role?: unknown;
    usage?: { cost?: { total?: number } | null; totalTokens?: number } | null;
  } | null;
};

/**
 * The conversation's usage, summed from the entries the turn already has.
 *
 * No I/O: these are in memory at the end of every turn, and the alternative —
 * re-reading the transcript — would read a file the caller just wrote.
 */
export const sumEntryUsage = (
  entries: readonly unknown[],
): SessionUsage => {
  let cost = 0;
  let tokens = 0;

  for (const entry of entries as readonly UsageBearingEntry[]) {
    // Assistant messages only. A user entry carries no usage, and counting a
    // role that later gains one would double the bill.
    if (entry?.message?.role !== "assistant") continue;
    const usage = entry.message.usage;
    if (!usage) continue;
    cost += usage.cost?.total ?? 0;
    tokens += usage.totalTokens ?? 0;
  }

  return { cost, tokens };
};

const withUsage = (meta: SessionMeta | null): SessionUsageRecord =>
  meta?.usage ?? EMPTY_USAGE_RECORD;

/** The record as stored, or null for a session that has never been stamped. */
export const readSessionUsage = (
  sessionId: string,
  dir?: string,
): SessionUsageRecord | null => {
  const meta = dir ? readSessionMeta(sessionId, dir) : readSessionMeta(sessionId);
  return meta?.usage ?? null;
};

const write = (
  sessionId: string,
  usage: SessionUsageRecord,
  dir?: string,
): void => {
  try {
    if (dir) writeSessionMeta(sessionId, { usage }, dir);
    else writeSessionMeta(sessionId, { usage });
  } catch {
    // See the docblock: a badge is not worth a turn.
  }
};

/** Replace the conversation half. Cumulative already, so a set rather than an add. */
export const stampConversationUsage = (
  sessionId: string,
  conversation: SessionUsage,
  dir?: string,
): void => {
  const meta = dir ? readSessionMeta(sessionId, dir) : readSessionMeta(sessionId);
  if (!meta) return;
  write(sessionId, { ...withUsage(meta), conversation }, dir);
};

/**
 * Adopt totals recovered from the backup.
 *
 * The one place Postgres is read for this, and only for a session written
 * before the stamp existed — the run files cannot supply the workflow half
 * retroactively, so without this those sessions would show a number that is
 * simply wrong until they next run a turn. Written to disk so it happens once
 * per session rather than once per render.
 */
export const adoptBackfilledUsage = (
  sessionId: string,
  record: SessionUsageRecord,
  dir?: string,
): void => {
  const meta = dir ? readSessionMeta(sessionId, dir) : readSessionMeta(sessionId);
  if (!meta || meta.usage) return;
  write(sessionId, record, dir);
};
