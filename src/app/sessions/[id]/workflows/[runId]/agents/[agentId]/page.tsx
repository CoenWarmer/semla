import { requireSessionOwner } from "@/lib/session-auth";
import { createClient } from "@/lib/supabase/server";
import type { AgentHistoryEntry } from "@/lib/pi/workflow-run-reader";
import { getAgentDetail } from "@/lib/pi/workflow-service";
import { TokenUsage } from "@/components/token-usage";
import Link from "next/link";
import { notFound } from "next/navigation";

const statusColors: Record<string, string> = {
  done: "text-green-600 dark:text-green-400",
  error: "text-destructive",
  queued: "text-muted-foreground",
  running: "text-primary",
  skipped: "text-muted-foreground",
};

/** Tokens the agent was carrying when it compacted, e.g. "128,000 tokens". */
function formatTokens(tokens: number | undefined): string | null {
  return typeof tokens === "number" ? `${tokens.toLocaleString()} tokens` : null;
}

function HistoryEntry({ entry }: { entry: AgentHistoryEntry }) {
  // Everything above this point left the agent's context here. Rendered as a
  // rule across the transcript rather than another message, because it is a
  // boundary between two things the agent could not see at once — and the
  // transcript keeps both sides, so without it they read as one conversation.
  if (entry.kind === "compaction") {
    const dropped = formatTokens(entry.tokensBefore);
    return (
      <div className="flex items-center gap-3 py-2">
        <div className="h-px flex-1 bg-amber-500/40" />
        <div className="text-center">
          <p className="text-xs font-medium uppercase tracking-wide text-amber-600 dark:text-amber-500">
            Context compacted
          </p>
          <p className="text-xs text-muted-foreground">
            {dropped
              ? `Everything above was summarised away; the agent was carrying ${dropped}.`
              : "Everything above was summarised away and the agent could no longer see it."}
          </p>
        </div>
        <div className="h-px flex-1 bg-amber-500/40" />
      </div>
    );
  }

  if (entry.kind === "toolCall") {
    return (
      <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm font-mono">
        <span className="text-muted-foreground">▶ {entry.toolName}</span>
        {entry.text && (
          <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-xs text-foreground/80">
            {entry.text}
          </pre>
        )}
      </div>
    );
  }

  if (entry.kind === "toolResult") {
    return (
      <div className="rounded-md border bg-muted/10 px-3 py-2 text-sm font-mono">
        <span className="text-muted-foreground">◀ {entry.toolName}</span>
        {entry.text && (
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap text-xs text-foreground/70">
            {entry.text}
          </pre>
        )}
      </div>
    );
  }

  if (entry.kind === "error") {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {entry.text}
      </div>
    );
  }

  return (
    <div
      className={
        entry.role === "assistant"
          ? "text-sm text-foreground"
          : "text-sm text-muted-foreground"
      }
    >
      <p className="whitespace-pre-wrap">{entry.text}</p>
    </div>
  );
}

export default async function AgentDetailPage({
  params,
}: {
  params: Promise<{ id: string; runId: string; agentId: string }>;
}) {
  const { id, runId, agentId } = await params;

  try {
    await requireSessionOwner(id);
  } catch {
    notFound();
  }

  // Verify the run belongs to this session.
  const supabase = await createClient();
  const { data: run } = await supabase
    .from("workflow_runs")
    .select("run_id")
    .eq("semla_session_id", id)
    .eq("run_id", runId)
    .maybeSingle();

  if (!run) {
    notFound();
  }

  // Same lookup the API route makes, so both surfaces resolve the transcript
  // identically rather than this page re-deriving it from the run file.
  const detail = getAgentDetail(runId, parseInt(agentId, 10));

  if ("reason" in detail) {
    notFound();
  }

  const { agent, workflowName } = detail;

  const durationMs =
    agent.startedAt && agent.endedAt
      ? new Date(agent.endedAt).getTime() - new Date(agent.startedAt).getTime()
      : undefined;

  const history: AgentHistoryEntry[] = agent.history ?? [];

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-8">
      <div>
        <Link
          className="text-muted-foreground text-sm hover:text-foreground"
          href={`/sessions/${id}`}
        >
          ← Back to session
        </Link>
      </div>

      <div className="space-y-1">
        <p className="text-muted-foreground text-xs uppercase tracking-wide">
          {workflowName}
          {agent.phase ? ` · ${agent.phase}` : ""}
        </p>
        <h1 className="text-2xl font-semibold">{agent.label}</h1>
        <div className="flex items-center gap-3 text-sm">
          <span className={statusColors[agent.status] ?? "text-muted-foreground"}>
            {agent.status}
          </span>
          {agent.model && (
            <span className="text-muted-foreground">{agent.model}</span>
          )}
          <TokenUsage
            className="text-muted-foreground"
            cost={agent.cost}
            tokens={agent.tokens}
          />
          {durationMs !== undefined && (
            <span className="text-muted-foreground">
              {(durationMs / 1000).toFixed(1)}s
            </span>
          )}
        </div>
      </div>

      <div className="rounded-md border bg-muted/20 px-4 py-3">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1">
          Prompt
        </p>
        <p className="text-sm whitespace-pre-wrap">{agent.prompt}</p>
      </div>

      {agent.error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {agent.error}
        </div>
      )}

      <div className="space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Transcript
          </p>
          {history.length > 0 && agent.historySource === "run-file" && (
            <p className="text-xs text-muted-foreground">
              Partial — no session transcript was persisted for this agent, so
              this is the run file&rsquo;s last {history.length}{" "}
              {history.length === 1 ? "entry" : "entries"}.
            </p>
          )}
        </div>
        {history.length === 0 ? (
          <p className="text-muted-foreground text-sm">No transcript available.</p>
        ) : (
          history.map((entry, i) => <HistoryEntry entry={entry} key={i} />)
        )}
      </div>
    </div>
  );
}
