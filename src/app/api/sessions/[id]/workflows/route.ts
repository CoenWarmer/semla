import { handleRouteError } from "@/lib/api-helpers";
import { finalizeBackgroundRun } from "@/lib/pi/session-persistence";
import { requireSessionOwner } from "@/lib/session-auth";
import { createClient } from "@/lib/supabase/server";
import { snapshotFromRunFile } from "@/lib/pi/workflow-service";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    await requireSessionOwner(id);
  } catch (error) {
    return handleRouteError(error, "Unable to authorize session.");
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("workflow_runs")
    .select("*")
    .eq("semla_session_id", id)
    .order("updated_at", { ascending: false });

  if (error) {
    console.error("[api:sessions/workflows] Unable to load workflow runs:", error);
    return Response.json(
      { error: `Unable to load workflow runs: ${error.message}` },
      { status: 500 }
    );
  }

  // For every run, prefer live data from the run file so agent progress is
  // always current (the DB snapshot is only updated for foreground runs).
  // Also auto-finalize any run whose continuation died (DB stuck at "running"
  // while the run file already shows completion).
  const runs = data.map((run) => {
    const liveSnapshot = snapshotFromRunFile(run.run_id);
    if (
      run.status === "running" &&
      liveSnapshot &&
      liveSnapshot.runningCount === 0 &&
      liveSnapshot.completedAt
    ) {
      const finalStatus = liveSnapshot.errorCount > 0 ? "failed" : "completed";
      void finalizeBackgroundRun(run.run_id, finalStatus);
      return { ...run, status: finalStatus, snapshot: liveSnapshot };
    }
    return { ...run, snapshot: liveSnapshot ?? run.snapshot };
  });

  return Response.json({ runs });
}
