"use client";

import { useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { ChartBarIcon, ChevronDownIcon, ChevronUpIcon } from "lucide-react";

import { BottomBarPanel } from "@/components/bottom-bar-panel";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { useToolUsageStats } from "@/hooks/use-tool-usage-stats";

/** This panel's id in the shared bottom bar. See bottom-panel.tsx. */
const OBSERVABILITY_PANEL = "observability";

type RangePreset = "24h" | "7d" | "30d" | "all";

const RANGE_LABELS: Record<RangePreset, string> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  all: "All time",
};

// "All time" needs a concrete lower bound rather than an open-ended query, so
// the API contract stays "always a range" and no route has to special-case an
// absent `from`. Semla did not exist before this date, so it is effectively
// unbounded for any real session.
const EPOCH = new Date("2000-01-01T00:00:00.000Z");

function rangeFor(preset: RangePreset, now: Date): { from: Date; to: Date } {
  if (preset === "all") return { from: EPOCH, to: now };
  const hours = preset === "24h" ? 24 : preset === "7d" ? 24 * 7 : 24 * 30;
  return { from: new Date(now.getTime() - hours * 60 * 60 * 1000), to: now };
}

const usageChartConfig: ChartConfig = {
  count: { label: "Occurrences", color: "var(--chart-1)" },
};

const failureChartConfig: ChartConfig = {
  failedCount: { label: "Failures", color: "var(--chart-3)" },
};

/**
 * The two bar charts, each built on the same buckets — one keyed by total
 * occurrences, one by failures. Recharts wants its own array shape per chart
 * rather than one dataset with two active bars, so each chart is handed the
 * same `buckets` array and simply looks at a different field.
 */
function ToolUsageCharts({
  buckets,
}: {
  buckets: { toolName: string; count: number; failedCount: number }[];
}) {
  const failedOnly = useMemo(
    () => buckets.filter((bucket) => bucket.failedCount > 0),
    [buckets],
  );

  return (
    <div className="flex h-full gap-6 overflow-x-auto p-3">
      <div className="min-w-0 flex-1">
        <p className="mb-2 text-sm font-medium">Tool usage</p>
        {buckets.length === 0 ? (
          <p className="text-sm text-muted-foreground">No tool calls in this range.</p>
        ) : (
          <ChartContainer config={usageChartConfig} className="aspect-auto h-[220px] w-full">
            <BarChart data={buckets} margin={{ left: 0, right: 8 }}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="toolName"
                tickLine={false}
                axisLine={false}
                interval={0}
                angle={-30}
                textAnchor="end"
                height={50}
              />
              <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={32} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="count" fill="var(--color-count)" radius={4} />
            </BarChart>
          </ChartContainer>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <p className="mb-2 text-sm font-medium">Failed tool calls</p>
        {failedOnly.length === 0 ? (
          <p className="text-sm text-muted-foreground">No failed tool calls in this range.</p>
        ) : (
          <ChartContainer config={failureChartConfig} className="aspect-auto h-[220px] w-full">
            <BarChart data={failedOnly} margin={{ left: 0, right: 8 }}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="toolName"
                tickLine={false}
                axisLine={false}
                interval={0}
                angle={-30}
                textAnchor="end"
                height={50}
              />
              <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={32} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="failedCount" fill="var(--color-failedCount)" radius={4} />
            </BarChart>
          </ChartContainer>
        )}
      </div>
    </div>
  );
}

/**
 * Tool usage across all sessions, shared with the console, the agent
 * timeline, the branch graph and the element picker via `BottomBarPanel` —
 * see that component's doc comment for why.
 *
 * Unlike the branch graph and the agent timeline, the button and the panel
 * itself render unconditionally, the same as the console — there is no
 * `sessionId` gate on whether this panel exists. The default scope is
 * "all sessions", per the spec; the "this session" tab is offered only when
 * a session is actually open, and the scope silently falls back to "all"
 * the moment it isn't (navigating away from a session while the panel is
 * open, for instance) rather than querying a session id that no longer
 * applies.
 */
export function ObservabilityPanel() {
  const { id } = useParams<{ id?: string }>();
  const sessionId = id ?? null;

  const [preset, setPreset] = useState<RangePreset>("7d");
  // "session" is only reachable when there is a session to scope to — see the
  // guard below, which falls back to "all" outside a session page.
  const [scope, setScope] = useState<"all" | "session">("all");
  const effectiveScope = sessionId ? scope : "all";

  // Computed once per preset change, not on every render, so the query key
  // — and therefore the request — stays stable while the panel sits open.
  const { from, to } = useMemo(() => rangeFor(preset, new Date()), [preset]);

  const query = useToolUsageStats(from, to, effectiveScope === "session" ? sessionId : null);

  return (
    <BottomBarPanel
      button={({ open, toggle }) => (
        <button
          aria-expanded={open}
          className="flex items-center gap-1.5 rounded px-1 text-muted-foreground transition-colors hover:text-foreground"
          onClick={toggle}
          title="Show tool usage across all sessions"
          type="button"
        >
          <ChartBarIcon className="size-3" />
          Observability
          {open ? (
            <ChevronDownIcon className="size-3" />
          ) : (
            <ChevronUpIcon className="size-3" />
          )}
        </button>
      )}
      panelId={OBSERVABILITY_PANEL}
    >
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          {sessionId && (
            <Tabs value={effectiveScope} onValueChange={(value) => setScope(value as "all" | "session")}>
              <TabsList>
                <TabsTrigger value="session">This session</TabsTrigger>
                <TabsTrigger value="all">All sessions</TabsTrigger>
              </TabsList>
            </Tabs>
          )}
          <Select value={preset} onValueChange={(value) => setPreset(value as RangePreset)}>
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(RANGE_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {query.isPending && (
            <p className="p-3 text-sm text-muted-foreground">Loading…</p>
          )}
          {query.isError && (
            <p className="p-3 text-sm text-destructive">
              {query.error instanceof Error ? query.error.message : "Unknown error"}
            </p>
          )}
          {query.data && <ToolUsageCharts buckets={query.data.buckets} />}
        </div>
      </div>
    </BottomBarPanel>
  );
}
