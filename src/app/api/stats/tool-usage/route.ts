import { handleRouteError, requireUser } from "@/lib/api/api-helpers";
import { listSessionMeta } from "@/lib/pi/session/session-meta";
import { computeToolUsageStats } from "@/lib/pi/tool-usage-stats";
import { createServerTiming } from "@/lib/api/server-timing";

export const runtime = "nodejs";

/**
 * Tool-call occurrence counts across this user's sessions, for the
 * Observability panel's bar charts.
 *
 * Disk only, unlike `/api/stats/usage`. That route falls back to Postgres for
 * sessions written before per-session meta files existed, because a lifetime
 * cost total silently missing a session would be wrong in the direction
 * nobody notices. A tool-usage breakdown does not carry that risk the same
 * way — it is diagnostic, not a balance — so the gap for pre-disk sessions is
 * accepted rather than paying for a second read path.
 *
 * An optional `sessionId` narrows to one session's own transcript, for the
 * panel's "this session" tab. Still filtered through the same `userId`
 * ownership check as the "all sessions" case, so naming another user's
 * session id in the query string cannot read their tool calls.
 */
export async function GET(request: Request) {
  const timing = createServerTiming();
  const withTiming = (body: unknown, status = 200) =>
    Response.json(body, {
      headers: { "Server-Timing": timing.header() },
      status,
    });

  try {
    const { user } = await timing.phase("auth", () => requireUser());
    const userId = user.id;

    const { searchParams } = new URL(request.url);
    const from = parseDate(searchParams.get("from"));
    const to = parseDate(searchParams.get("to"));
    if (!from || !to) {
      return withTiming(
        { error: "Query params 'from' and 'to' must be valid ISO timestamps." },
        400,
      );
    }

    const sessionId = searchParams.get("sessionId");

    const sessions = await timing.phase("disk-sessions", async () =>
      listSessionMeta().filter(
        (meta) => meta.userId === userId && (!sessionId || meta.id === sessionId),
      ),
    );

    const buckets = await timing.phase("tool-usage", async () =>
      computeToolUsageStats(sessions, { from, to }),
    );

    return withTiming({ buckets });
  } catch (error) {
    return handleRouteError(error, "Unable to compute tool usage stats.");
  }
}

const parseDate = (value: string | null): Date | null => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};
