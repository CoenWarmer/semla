import { handleRouteError } from "@/lib/api-helpers";
import { detach } from "@/lib/pi/session-log";
import { finalizeBackgroundRun } from "@/lib/pi/session-persistence";
import { listWorkflowRuns } from "@/lib/pi/workflow-run-index";
import { snapshotFromRunFile } from "@/lib/pi/workflow-service";
import { createServerTiming } from "@/lib/server-timing";
import { createClient } from "@/lib/supabase/server";
import type { WorkflowSnapshot } from "@/types/workflow";

export const runtime = "nodejs";

// Exactly the columns WorkflowRun (see hooks/use-workflow-runs.ts) consumes.
//
// `snapshot` is deliberately absent. The on-disk run file is authoritative and
// overrides it below, so selecting it up front transferred the whole JSONB
// column — measured at 195KB for a single run, 99.9% of the response — only to
// throw it away, on every 2s poll. It is fetched in a second, targeted query
// for the runs that have no file on disk, which is normally none of them.
//
// `id`, `semla_session_id` and `result` are dropped for the same reason: the
// client never reads them.
const RUN_COLUMNS = "run_id,mode,status,error,created_at,updated_at";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const timing = createServerTiming();

  try {
    const supabase = await createClient();

    // The proxy (src/proxy.ts) already verified this request's JWT, so read the
    // claims rather than paying another `auth.getUser()` round-trip to the auth
    // server. Row-level authorization is not skipped, it moves to where it is
    // already enforced: the workflow_runs SELECT policy (migration
    // 20260822164000) exposes only runs whose session has
    // `user_id = auth.uid()`, so another user's session id returns an empty
    // list instead of a 404 — one fewer round-trip and no id disclosure.
    const { data: claimsData } = await timing.phase("auth", () =>
      supabase.auth.getClaims(),
    );

    if (!claimsData?.claims.sub) {
      return Response.json(
        { error: "Authentication required." },
        { status: 401 },
      );
    }

    // Which runs a session has is on disk; the snapshots they point at already
    // were. Postgres answers only for sessions whose runs predate the index.
    const localRuns = await timing.phase("disk-index", () =>
      Promise.resolve(listWorkflowRuns(id)),
    );

    const { data, error } = localRuns.length
      ? { data: null, error: null }
      : await timing.phase("db-runs", () =>
          supabase
            .from("workflow_runs")
            .select(RUN_COLUMNS)
            .eq("semla_session_id", id)
            .order("updated_at", { ascending: false }),
        );

    if (error) {
      console.error(
        "[api:sessions/workflows] Unable to load workflow runs:",
        error,
      );
      return Response.json(
        { error: `Unable to load workflow runs: ${error.message}` },
        { status: 500 },
      );
    }

    const rows = localRuns.length ? localRuns : (data ?? []);

    // Prefer live data from the run file so agent progress is always current
    // (the DB snapshot is only updated for foreground runs).
    const withDisk = await timing.phase("disk", () =>
      rows.map((run) => ({ run, snapshot: snapshotFromRunFile(run.run_id) })),
    );

    // Fall back to the stored snapshot only where the run file is missing —
    // a run persisted by another machine, or one whose file has been pruned.
    const missing = withDisk
      .filter((entry) => !entry.snapshot)
      .map((entry) => entry.run.run_id);
    const stored = new Map<string, WorkflowSnapshot | null>();

    if (missing.length > 0) {
      const { data: snapshotRows, error: snapshotError } = await timing.phase(
        "db-snapshots",
        () =>
          supabase
            .from("workflow_runs")
            .select("run_id,snapshot")
            .in("run_id", missing),
      );

      if (snapshotError) {
        // Non-fatal: the run still renders from its scalar columns, just
        // without agent detail.
        console.error(
          "[api:sessions/workflows] Unable to load stored snapshots:",
          snapshotError,
        );
      } else {
        for (const row of snapshotRows ?? []) {
          stored.set(row.run_id, row.snapshot as WorkflowSnapshot | null);
        }
      }
    }

    // Auto-finalize any run whose continuation died (DB stuck at "running"
    // while the run file already shows completion).
    const runs = withDisk.map(({ run, snapshot }) => {
      if (
        run.status === "running" &&
        snapshot &&
        snapshot.runningCount === 0 &&
        snapshot.completedAt
      ) {
        const finalStatus = snapshot.errorCount > 0 ? "failed" : "completed";
        detach(
          id,
          "finalize run",
          finalizeBackgroundRun(id, run.run_id, finalStatus),
        );
        return { ...run, snapshot, status: finalStatus };
      }
      return { ...run, snapshot: snapshot ?? stored.get(run.run_id) ?? null };
    });

    return Response.json(
      { runs },
      { headers: { "Server-Timing": timing.header() } },
    );
  } catch (error) {
    return handleRouteError(error, "Unable to load workflow runs.");
  }
}
