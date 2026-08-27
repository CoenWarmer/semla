"use client";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  useContextCheckResult,
  useTriggerContextCheck,
} from "@/hooks/use-context-check";
import type { ContextCheckResult, DimensionLevel } from "@/app/api/sessions/[id]/context-check/route";
import {
  AlertTriangleIcon,
  CheckCircleIcon,
  RefreshCwIcon,
  XCircleIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect } from "react";

// ---- Helpers ------------------------------------------------------------

function levelColor(level: DimensionLevel) {
  if (level === "degraded") return "text-destructive";
  if (level === "warning") return "text-yellow-500";
  return "text-green-500";
}

function LevelIcon({ level }: { level: DimensionLevel }) {
  if (level === "degraded")
    return <XCircleIcon className="size-3.5 shrink-0 text-destructive" />;
  if (level === "warning")
    return <AlertTriangleIcon className="size-3.5 shrink-0 text-yellow-500" />;
  return <CheckCircleIcon className="size-3.5 shrink-0 text-green-500" />;
}

function DotIndicator({ level }: { level: DimensionLevel }) {
  const bg =
    level === "degraded"
      ? "bg-destructive"
      : level === "warning"
        ? "bg-yellow-500"
        : "bg-green-500";
  return <span className={`size-2 rounded-full shrink-0 ${bg}`} />;
}

function formatCheckedAt(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

// ---- Dimension row ------------------------------------------------------

function DimensionRow({
  label,
  score,
}: {
  label: string;
  score: { level: DimensionLevel; summary: string };
}) {
  return (
    <div className="flex items-start gap-2 py-1.5">
      <LevelIcon level={score.level} />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-foreground">{label}</span>
          <span className={`text-xs font-medium capitalize ${levelColor(score.level)}`}>
            {score.level}
          </span>
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">{score.summary}</p>
      </div>
    </div>
  );
}

// ---- Composition bar ----------------------------------------------------

function CompositionBar({
  userFraction,
  assistantFraction,
  toolResultFraction,
}: {
  assistantFraction: number;
  toolResultFraction: number;
  userFraction: number;
}) {
  const other = Math.max(0, 1 - userFraction - assistantFraction - toolResultFraction);
  return (
    <div className="mt-1 mb-0.5">
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="bg-blue-500"
          style={{ flexBasis: 0, flexGrow: userFraction }}
          title={`User: ${Math.round(userFraction * 100)}%`}
        />
        <div
          className="bg-violet-500"
          style={{ flexBasis: 0, flexGrow: assistantFraction }}
          title={`Assistant: ${Math.round(assistantFraction * 100)}%`}
        />
        <div
          className="bg-amber-500"
          style={{ flexBasis: 0, flexGrow: toolResultFraction }}
          title={`Tool results: ${Math.round(toolResultFraction * 100)}%`}
        />
        {other > 0.01 && (
          <div
            className="bg-muted-foreground/20"
            style={{ flexBasis: 0, flexGrow: other }}
          />
        )}
      </div>
      <div className="mt-1 flex gap-3 text-[10px] text-muted-foreground">
        <span>
          <span className="inline-block size-1.5 rounded-full bg-blue-500 mr-1 align-middle" />
          User {Math.round(userFraction * 100)}%
        </span>
        <span>
          <span className="inline-block size-1.5 rounded-full bg-violet-500 mr-1 align-middle" />
          Assistant {Math.round(assistantFraction * 100)}%
        </span>
        <span>
          <span className="inline-block size-1.5 rounded-full bg-amber-500 mr-1 align-middle" />
          Tool results {Math.round(toolResultFraction * 100)}%
        </span>
      </div>
    </div>
  );
}

// ---- Inspector panel ----------------------------------------------------

export function InspectorPanel({
  goal,
  sessionId,
}: {
  goal?: string | null;
  sessionId: string;
}) {
  const { data: result } = useContextCheckResult(sessionId);
  const trigger = useTriggerContextCheck(sessionId);
  const router = useRouter();

  // Auto-run on first open when there is no cached result yet.
  useEffect(() => {
    if (!result && !trigger.isPending) {
      trigger.mutate();
    }
    // Only run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleIntervention = useCallback(
    (action: ContextCheckResult["interventions"][number]["action"]) => {
      if (action === "restart") {
        router.push("/sessions/new");
      } else if (action === "restate-goal" && goal) {
        // Copy goal to clipboard so user can paste it as a new message
        void navigator.clipboard.writeText(
          `To refocus: my goal is — ${goal}`,
        );
      }
      // "summarize" — user acts on it manually for now
    },
    [goal, router],
  );

  return (
    <div className="flex h-full flex-col gap-0 py-3 px-1">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between pb-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-foreground">
            Context Inspector
          </span>
          {result && (
            <span className="text-[10px] text-muted-foreground">
              {formatCheckedAt(result.checkedAt)}
            </span>
          )}
        </div>
        <Button
          disabled={trigger.isPending}
          onClick={() => trigger.mutate()}
          size="sm"
          variant="outline"
        >
          {trigger.isPending ? (
            <Spinner className="size-3" />
          ) : (
            <RefreshCwIcon className="size-3" />
          )}
          {trigger.isPending ? "Inspecting…" : result ? "Re-run" : "Run inspector"}
        </Button>
      </div>

      {/* Loading */}
      {trigger.isPending && !result && (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          Running inspector agent…
        </div>
      )}

      {/* Empty state */}
      {!trigger.isPending && !result && (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 text-center">
          <p className="text-sm text-muted-foreground">
            The inspector runs as a separate agent and evaluates context health
            without touching this session.
          </p>
          <p className="text-xs text-muted-foreground/70 mt-1">
            It also runs automatically every 10 turns.
          </p>
        </div>
      )}

      {/* Results */}
      {result && (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          {/* Overall */}
          <div className="flex items-start gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2">
            <DotIndicator level={result.quality} />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className={`text-xs font-semibold capitalize ${levelColor(result.quality)}`}>
                {result.quality}
              </span>
              <p className="text-xs text-muted-foreground leading-relaxed">
                {result.summary}
              </p>
            </div>
          </div>

          {/* Dimensions */}
          <div className="flex flex-col divide-y divide-border/40">
            <DimensionRow
              label="Correction rate"
              score={result.dimensions.correctionRate}
            />

            {/* Composition — informational only, no pass/fail */}
            <div className="py-1.5">
              <span className="text-xs font-medium text-foreground">Composition</span>
              <CompositionBar
                assistantFraction={result.dimensions.composition.assistantFraction}
                toolResultFraction={result.dimensions.composition.toolResultFraction}
                userFraction={result.dimensions.composition.userFraction}
              />
            </div>

            <DimensionRow
              label="Supersession depth"
              score={result.dimensions.supersessionDepth}
            />
            <DimensionRow label="Staleness" score={result.dimensions.staleness} />
            <DimensionRow label="Goal drift" score={result.dimensions.goalDrift} />
          </div>

          {/* Interventions */}
          {result.interventions.length > 0 && (
            <div className="flex shrink-0 flex-col gap-1.5 pt-1">
              <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Suggested interventions
              </span>
              <div className="flex flex-wrap gap-2">
                {result.interventions.map((iv) => (
                  <Button
                    key={iv.action}
                    onClick={() => handleIntervention(iv.action)}
                    size="sm"
                    variant={iv.action === "restart" ? "destructive" : "outline"}
                  >
                    {iv.label}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
