/**
 * Tool-call occurrence counts across sessions, for the Observability panel.
 *
 * Disk-first, like every other stats route: `listSessionMeta()` for the
 * candidate sessions, `readSessionEntries` + `buildTranscript` for each
 * session's tool calls, the same pair `getTranscript` uses for a single
 * session's timeline. No new parsing — this only tallies what
 * `SessionToolCall.name` / `isError` already carry.
 *
 * The range filter is applied to a session's `createdAt`, not to each tool
 * call's own timestamp. That is a deliberate approximation: it lets a session
 * outside the range be skipped without opening its file, which matters once
 * there are enough sessions on disk to make "read every file every time"
 * expensive. The cost is that a long-running session straddling a range
 * boundary is counted (or excluded) wholesale rather than split at the
 * boundary. Sessions are typically short-lived, so this should rarely be
 * visible; if it becomes visible, per-call filtering is the fix, not a cache.
 */

import { readSessionEntries } from "@/lib/pi/session/session-file";
import type { SessionMeta } from "@/lib/pi/session/session-meta";
import { PI_SESSION_DIR } from "@/lib/pi/runtime/runtime-config";
import { buildTranscript } from "@/lib/pi/transcript";

export type ToolUsageBucket = {
  toolName: string;
  count: number;
  failedCount: number;
};

export type ToolUsageRange = {
  from: Date;
  to: Date;
};

/**
 * One bucket per distinct tool name, sorted by total occurrences descending
 * so the chart's biggest bars land first without the caller re-sorting.
 */
export function computeToolUsageStats(
  sessions: readonly SessionMeta[],
  range: ToolUsageRange,
  dir: string = PI_SESSION_DIR,
): ToolUsageBucket[] {
  const fromMs = range.from.getTime();
  const toMs = range.to.getTime();

  const buckets = new Map<string, ToolUsageBucket>();

  for (const meta of sessions) {
    const createdAtMs = Date.parse(meta.createdAt);
    if (Number.isNaN(createdAtMs) || createdAtMs < fromMs || createdAtMs > toMs) {
      continue;
    }

    const entries = readSessionEntries(meta.id, dir);
    if (!entries) continue;

    const { toolCalls } = buildTranscript(entries);
    for (const call of toolCalls) {
      const bucket = buckets.get(call.name) ?? {
        toolName: call.name,
        count: 0,
        failedCount: 0,
      };
      bucket.count += 1;
      if (call.isError) bucket.failedCount += 1;
      buckets.set(call.name, bucket);
    }
  }

  return [...buckets.values()].sort((a, b) => b.count - a.count);
}
