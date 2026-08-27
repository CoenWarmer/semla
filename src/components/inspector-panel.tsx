"use client";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  useContextInspections,
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
import { useCallback, useEffect, useState } from "react";

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

type CompositionMode = "absolute" | "relative";

function CompositionBar({
  assistantFraction,
  contextWindowFraction,
  mode,
  systemPromptFraction,
  toolResultFraction,
  userFraction,
}: {
  assistantFraction: number;
  contextWindowFraction: number | null;
  mode: CompositionMode;
  systemPromptFraction: number;
  toolResultFraction: number;
  userFraction: number;
}) {
  // In absolute mode the segments scale down by the context window fill so the
  // bar's used area represents actual context consumption. Fall back to relative
  // if contextWindowFraction is unknown.
  const scale = mode === "absolute" && contextWindowFraction != null ? contextWindowFraction : 1;

  const seg = {
    system: systemPromptFraction * scale,
    user: userFraction * scale,
    assistant: assistantFraction * scale,
    toolResult: toolResultFraction * scale,
  };
  // In relative mode fill the bar fully; in absolute mode leave the rest as background.
  const remainder = mode === "absolute" && contextWindowFraction != null
    ? Math.max(0, 1 - contextWindowFraction)
    : 0;

  const pct = (f: number) => `${Math.round(f * 100)}%`;

  return (
    <div className="mt-1 mb-0.5">
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
        {seg.system > 0.001 && (
          <div
            className="bg-emerald-500"
            style={{ flexBasis: 0, flexGrow: seg.system }}
            title={`System prompt: ${pct(systemPromptFraction)}`}
          />
        )}
        <div
          className="bg-blue-500"
          style={{ flexBasis: 0, flexGrow: seg.user }}
          title={`User: ${pct(userFraction)}`}
        />
        <div
          className="bg-violet-500"
          style={{ flexBasis: 0, flexGrow: seg.assistant }}
          title={`Assistant: ${pct(assistantFraction)}`}
        />
        <div
          className="bg-amber-500"
          style={{ flexBasis: 0, flexGrow: seg.toolResult }}
          title={`Tool results: ${pct(toolResultFraction)}`}
        />
        {remainder > 0.001 && (
          <div style={{ flexBasis: 0, flexGrow: remainder }} />
        )}
      </div>
      <div className="mt-1 flex flex-wrap gap-3 text-[10px] text-muted-foreground">
        {systemPromptFraction > 0.001 && (
          <span>
            <span className="inline-block size-1.5 rounded-full bg-emerald-500 mr-1 align-middle" />
            System {pct(systemPromptFraction)}
          </span>
        )}
        <span>
          <span className="inline-block size-1.5 rounded-full bg-blue-500 mr-1 align-middle" />
          User {pct(userFraction)}
        </span>
        <span>
          <span className="inline-block size-1.5 rounded-full bg-violet-500 mr-1 align-middle" />
          Assistant {pct(assistantFraction)}
        </span>
        <span>
          <span className="inline-block size-1.5 rounded-full bg-amber-500 mr-1 align-middle" />
          Tool results {pct(toolResultFraction)}
        </span>
        {mode === "absolute" && contextWindowFraction != null && (
          <span className="ml-auto text-muted-foreground/60">
            {pct(contextWindowFraction)} of context window
          </span>
        )}
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
  const { data: inspections, isLoading: inspectionsLoading } = useContextInspections(sessionId);
  const trigger = useTriggerContextCheck(sessionId);
  const router = useRouter();
  const [compositionMode, setCompositionMode] = useState<CompositionMode>("absolute");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const hasHistory = (inspections?.length ?? 0) > 0;
  // Most recent first; selectedId tracks which one the user is viewing.
  const selected = inspections?.find((r) => r.id === selectedId) ?? inspections?.[0] ?? null;
  const result = selected?.result ?? null;

  // Auto-run on first open when there is no history yet.
  useEffect(() => {
    if (!inspectionsLoading && !hasHistory && !trigger.isPending) {
      trigger.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inspectionsLoading]);

  const handleIntervention = useCallback(
    (action: ContextCheckResult["interventions"][number]["action"]) => {
      if (action === "restart") {
        router.push("/sessions/new");
      } else if (action === "restate-goal" && goal) {
        void navigator.clipboard.writeText(`To refocus: my goal is — ${goal}`);
      }
    },
    [goal, router],
  );

  return (
    <div className="flex h-full gap-0">
      {/* History sidebar */}
      <div className="flex w-32 shrink-0 flex-col border-r border-border/40 py-3 pr-2 gap-1 overflow-y-auto">
        <span className="mb-1 px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Runs
        </span>
        {inspectionsLoading && (
          <div className="flex items-center justify-center py-4">
            <Spinner className="size-3" />
          </div>
        )}
        {!inspectionsLoading && !hasHistory && (
          <span className="px-1 text-[10px] text-muted-foreground">No runs yet</span>
        )}
        {inspections?.map((insp, i) => {
          const isActive = insp.id === (selected?.id ?? null);
          const colors: Record<string, string> = {
            good: "bg-green-500",
            warning: "bg-yellow-500",
            degraded: "bg-destructive",
          };
          const dot = colors[insp.result.quality] ?? "bg-muted";
          return (
            <button
              key={insp.id}
              className={`flex flex-col rounded px-2 py-1.5 text-left transition-colors ${isActive ? "bg-muted" : "hover:bg-muted/50"}`}
              onClick={() => setSelectedId(insp.id)}
            >
              <div className="flex items-center gap-1.5">
                <span className={`size-1.5 rounded-full shrink-0 ${dot}`} />
                <span className="text-[10px] font-medium text-foreground capitalize">
                  {insp.result.quality}
                </span>
                {i === 0 && (
                  <span className="text-[9px] text-muted-foreground/60 ml-auto">latest</span>
                )}
              </div>
              <span className="mt-0.5 text-[10px] text-muted-foreground">
                {formatCheckedAt(insp.createdAt)}
              </span>
            </button>
          );
        })}
      </div>

      {/* Detail area */}
      <div className="flex min-w-0 flex-1 flex-col py-3 pl-3 gap-0">
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between pb-2">
          <span className="text-xs font-semibold text-foreground">
            {result ? formatCheckedAt(selected!.createdAt) : "Context Inspector"}
          </span>
          <Button
            disabled={trigger.isPending}
            onClick={() => trigger.mutate()}
            size="sm"
            variant="outline"
          >
            {trigger.isPending ? <Spinner className="size-3" /> : <RefreshCwIcon className="size-3" />}
            {trigger.isPending ? "Inspecting…" : hasHistory ? "Re-run" : "Run inspector"}
          </Button>
        </div>

        {/* Loading new run */}
        {trigger.isPending && !result && (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Spinner className="size-4" />
            Running inspector agent…
          </div>
        )}

        {/* Empty state */}
        {!trigger.isPending && !result && (
          <div className="flex flex-1 flex-col items-center justify-center gap-1 text-center px-4">
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
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
            {/* Overall */}
            <div className="flex items-start gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2">
              <DotIndicator level={result.quality} />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className={`text-xs font-semibold capitalize ${levelColor(result.quality)}`}>
                  {result.quality}
                </span>
                <p className="text-xs text-muted-foreground leading-relaxed">{result.summary}</p>
              </div>
            </div>

            {/* Dimensions */}
            <div className="flex flex-col divide-y divide-border/40">
              <DimensionRow label="Correction rate" score={result.dimensions.correctionRate} />

              {/* Composition */}
              <div className="py-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-foreground">Composition</span>
                  {result.dimensions.composition.contextWindowFraction != null && (
                    <button
                      className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                      onClick={() =>
                        setCompositionMode((m: CompositionMode) =>
                          m === "absolute" ? "relative" : "absolute",
                        )
                      }
                      title={compositionMode === "absolute" ? "Switch to proportional view" : "Switch to context window view"}
                    >
                      {compositionMode === "absolute" ? "vs. context window" : "proportional"}
                    </button>
                  )}
                </div>
                <CompositionBar
                  assistantFraction={result.dimensions.composition.assistantFraction}
                  contextWindowFraction={result.dimensions.composition.contextWindowFraction}
                  mode={compositionMode}
                  systemPromptFraction={result.dimensions.composition.systemPromptFraction}
                  toolResultFraction={result.dimensions.composition.toolResultFraction}
                  userFraction={result.dimensions.composition.userFraction}
                />
              </div>

              <DimensionRow label="Supersession depth" score={result.dimensions.supersessionDepth} />
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
    </div>
  );
}
