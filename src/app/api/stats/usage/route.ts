import { handleRouteError } from "@/lib/api-helpers";
import { listSessionMeta } from "@/lib/pi/session-meta";
import {
  sessionUsageTotals,
  totalUsage,
} from "@/lib/pi/session-usage-totals";
import { createServerTiming } from "@/lib/server-timing";
import { createAdminClient } from "@/lib/supabase-admin";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * What this user has spent, across every session.
 *
 * Disk answers this now. The totals are stamped into each session's meta as
 * they are spent, so the whole route is a directory read and a sum — where it
 * used to be four Postgres queries, a read of every workflow run file, and a
 * paged scan of every assistant entry.
 *
 * It also had the bug the sidebar and the top bar had, and had it worst: a
 * session with any workflow run was filtered *out* of the message sum, so
 * every such session contributed its subagents and none of its conversation.
 * `sessionUsageTotals` is now the single place that decides, and it adds the
 * two rather than choosing between them.
 */
export async function GET() {
  const timing = createServerTiming();
  const withTiming = (body: unknown, status = 200) =>
    Response.json(body, {
      headers: { "Server-Timing": timing.header() },
      status,
    });

  try {
    const supabase = await createClient();

    // The proxy (src/proxy.ts) already verified this request's JWT, and the
    // project signs with ES256, so getClaims() verifies locally against a
    // cached JWKS instead of making an auth.getUser() round-trip.
    const { data: claimsData } = await timing.phase("auth", () =>
      supabase.auth.getClaims(),
    );
    const userId = claimsData?.claims.sub;

    if (!userId) {
      return withTiming({ error: "Authentication required." }, 401);
    }

    // Disk records answer first, the same way the sidebar builds its list.
    // Postgres is asked only for sessions that have no record on disk — ones
    // that predate them — because a total that silently omitted those would
    // be wrong in the direction nobody notices.
    const onDisk = await timing.phase("disk-sessions", async () =>
      listSessionMeta().filter((meta) => meta.userId === userId),
    );
    const ids = new Set(onDisk.map((meta) => meta.id));

    const admin = createAdminClient();
    const { data: rows, error } = await timing.phase("db-sessions", () =>
      admin.from("sessions").select("id").eq("user_id", userId),
    );
    if (error) throw new Error(error.message);
    for (const row of rows ?? []) ids.add(row.id);

    if (ids.size === 0) return withTiming({ cost: 0, tokens: 0 });

    const totals = await timing.phase("usage", () =>
      sessionUsageTotals(admin, [...ids]),
    );

    return withTiming(totalUsage(totals));
  } catch (error) {
    return handleRouteError(error, "Unable to compute usage stats.");
  }
}
