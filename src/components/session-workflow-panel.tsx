"use client";

import { Canvas } from "@/components/ai-elements/canvas";
import { Controls } from "@/components/ai-elements/controls";
import { Edge } from "@/components/ai-elements/edge";
import {
  Node as WorkflowNode,
  NodeContent,
  NodeDescription,
  NodeFooter,
  NodeHeader,
  NodeTitle,
} from "@/components/ai-elements/node";
import type {
  SessionMessage,
  SessionToolCall,
} from "@/hooks/use-session-messages";
import type { WorkflowAgentSnapshot, WorkflowSnapshot } from "@/types/workflow";
import type {
  Edge as FlowEdge,
  Node as FlowNode,
  NodeProps,
} from "@xyflow/react";
import {
  TraceWaterfall,
  darkTheme,
  useTheme,
} from "react-otel-trace-waterfall";
import type {
  FitButtonProps,
  FollowButtonProps,
  SpanBarProps,
  SpanNameProps,
  SpanNode,
} from "react-otel-trace-waterfall";
import { numberAttr, stringAttr } from "react-otel-trace-waterfall";
import { workflowSnapshotToSpans } from "@/lib/workflow-spans";
import type { WorkflowRun } from "@/hooks/use-workflow-runs";
import { useNodesState, useReactFlow } from "@xyflow/react";
import {
  BrainIcon,
  ChevronDownIcon,
  GanttChartIcon,
  NetworkIcon,
  XIcon,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { SpanTooltipProps } from "react-otel-trace-waterfall";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Spinner } from "@/components/ui/spinner";
import { TokenUsage } from "@/components/token-usage";
import { CodeBlockContent } from "@/components/ai-elements/code/code-block";
import type { BundledLanguage } from "shiki";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

function FitViewOnChange({
  expanded,
  nodeCount,
}: {
  expanded: boolean;
  nodeCount: number;
}) {
  const { fitView } = useReactFlow();
  const prevNodeCount = useRef(nodeCount);
  const prevExpanded = useRef(expanded);
  useEffect(() => {
    const nodeCountChanged = nodeCount !== prevNodeCount.current;
    const expandedChanged = expanded !== prevExpanded.current;
    prevNodeCount.current = nodeCount;
    prevExpanded.current = expanded;
    if (nodeCountChanged) {
      void fitView({ duration: 300, padding: 0.25 });
    } else if (expandedChanged) {
      // Delay until the 200ms height transition completes.
      const id = setTimeout(
        () => fitView({ duration: 300, padding: 0.25 }),
        220,
      );
      return () => clearTimeout(id);
    }
  }, [nodeCount, expanded, fitView]);
  return null;
}

type WorkflowNodeData = {
  agent?: WorkflowAgentSnapshot;
  onAgentClick?: (agentId: number, runId: string) => void;
  phase: string;
  runId?: string;
};

type OrchestratorNodeData = { name: string };
type OrchestratorFlowNode = FlowNode<OrchestratorNodeData, "orchestrator">;

const OrchestratorNode = ({ data }: NodeProps<OrchestratorFlowNode>) => (
  <WorkflowNode handles={{ source: true, target: false }}>
    <NodeHeader>
      <NodeTitle>Session agent</NodeTitle>
      <NodeDescription>Running {data.name}</NodeDescription>
    </NodeHeader>
  </WorkflowNode>
);

const statusLabel: Record<WorkflowAgentSnapshot["status"], string> = {
  done: "Complete",
  error: "Failed",
  queued: "Queued",
  running: "Running",
  skipped: "Skipped",
};

type AgentFlowNode = FlowNode<WorkflowNodeData, "agent">;

const AgentNode = ({ data }: NodeProps<AgentFlowNode>) => {
  const agent = data.agent;
  const clickable = Boolean(agent && data.runId && data.onAgentClick);

  const handleClick = () => {
    if (agent && data.runId && data.onAgentClick) {
      data.onAgentClick(agent.id, data.runId);
    }
  };

  return (
    <WorkflowNode
      className={
        [
          agent?.status === "running" ? "ring-2 ring-primary" : undefined,
          clickable
            ? "cursor-pointer hover:ring-2 hover:ring-muted-foreground/50 transition-shadow"
            : undefined,
        ]
          .filter(Boolean)
          .join(" ") || undefined
      }
      handles={{ source: true, target: true }}
      onClick={handleClick}
    >
      <NodeHeader>
        <NodeTitle>{agent?.label ?? data.phase}</NodeTitle>
        <NodeDescription>
          {agent ? statusLabel[agent.status] : "Waiting for agents"}
        </NodeDescription>
      </NodeHeader>
      {agent && (
        <NodeContent className="text-muted-foreground text-xs">
          {agent.model ?? "Session model"}
          {agent.resultPreview && (
            <p className="mt-2 line-clamp-3">{agent.resultPreview}</p>
          )}
          {agent.error && (
            <p className="mt-2 text-destructive">{agent.error}</p>
          )}
        </NodeContent>
      )}
      {agent && (
        <NodeFooter className="text-muted-foreground text-xs">
          <TokenUsage
            cost={agent.cost}
            emptyLabel="No usage reported"
            tokens={agent.tokens}
          />
        </NodeFooter>
      )}
    </WorkflowNode>
  );
};

const nodeTypes = { agent: AgentNode, orchestrator: OrchestratorNode };
const edgeTypes = { animated: Edge.Animated };

const COL_WIDTH = 440;
const ROW_HEIGHT = 200;

// Hoisted so the theme keeps its identity across renders — the library memoises
// the merged theme on this prop. spanNameFontSize restores the 13px label the
// row used before the library owned that styling.
const TIMELINE_THEME = { ...darkTheme, spanNameFontSize: 13 };

// Injected once next to the waterfall rather than per row: it is a global
// keyframes rule, and SpanBar may render it on many rows at once.
const SHIMMER_STYLE = `
@keyframes span-shimmer {
  0%   { background-position: 200% center; }
  100% { background-position: -200% center; }
}
`;

// ── Row slots ────────────────────────────────────────────────────────────────
// The waterfall renders the row; these replace only the parts that need to
// reflect agent status. Layout, truncation, chevron, hit areas and selection
// stay with the library (see docs/plans/waterfall-row-slots.md).

function paletteColor(service: string | undefined, palette: readonly string[]) {
  if (!service) return palette[0];
  let n = 0;
  for (let i = 0; i < service.length; i++)
    n = (n * 31 + service.charCodeAt(i)) | 0;
  return palette[Math.abs(n) % palette.length];
}

/** Only shows while the pointer is over a folded marker, not over a row's bar. */
function InlineEventTooltip({ event }: SpanTooltipProps) {
  if (!event) return null;
  return (
    <div
      style={{
        padding: "5px 9px",
        fontSize: 12,
        lineHeight: "1.4",
        maxWidth: 300,
        wordBreak: "break-word",
        whiteSpace: "pre-wrap",
      }}
    >
      {event.name}
    </div>
  );
}

/** Agent status as recorded on the span by workflow-spans. */
const piStatusOf = (span: SpanNode) => stringAttr(span, "pi.status");

/**
 * A span's name, with the status cues the timeline needs: a shimmer and a
 * spinner while it runs, a dot while it is queued.
 *
 * The indicators live here rather than in RowPrefixComponent because that slot
 * renders at the leading edge of the row, before the label column — these
 * belong after the name.
 */
function SpanName({ span }: SpanNameProps) {
  const t = useTheme();
  const isError = span.status?.code === "ERROR";
  const status = piStatusOf(span);
  const isRunning = status === "running";
  const isQueued = status === "queued";

  return (
    <span
      style={
        {
          alignItems: "center",
          display: "inline-flex",
          gap: 6,
          maxWidth: "100%",
          minWidth: 0,
          // Shimmer reads its base and sweep colours from these two vars. Its
          // defaults follow the app theme, but this panel is pinned to
          // darkTheme, so in light mode the default base would be dark grey on
          // a dark row. Restate them in the waterfall's palette: the row's own
          // label colour, swept by the same highlight the running bar uses.
          ...(isRunning && !isError
            ? {
                "--color-muted-foreground": t.spanNameColor,
                "--color-background": "rgba(255,255,255,0.85)",
              }
            : {}),
        } as React.CSSProperties
      }
    >
      {/*
        Shimmer only for a running span. It paints the text itself
        (bg-clip-text + text-transparent), so rendering it unconditionally with
        duration 0 would drop both the inherited spanNameErrorColor on failed
        rows and the row's own label colour on the rest — and leave an
        infinitely repeating animation mounted on every row.
      */}
      {isRunning && !isError ? (
        // Shimmer paints an inline-block, which the parent's ellipsis cannot
        // truncate — so it truncates itself.
        <Shimmer
          as="span"
          className="max-w-full overflow-hidden text-ellipsis whitespace-nowrap"
          duration={2}
        >
          {span.name}
        </Shimmer>
      ) : (
        <span
          style={{
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {span.name}
        </span>
      )}
      {isRunning && (
        <span style={{ display: "inline-flex", flexShrink: 0, opacity: 0.7 }}>
          <Spinner className="size-3" />
        </span>
      )}
      {isQueued && (
        <span style={{ flexShrink: 0, fontSize: 10, opacity: 0.4 }}>·</span>
      )}
    </span>
  );
}

/**
 * A span's bar, coloured by service and animated while the span is running.
 * The library owns the bar's position and its click/hit area; this fills the
 * container it is given, or renders nothing for a row that is only a container
 * for folded markers.
 */
function SpanBar({ row, span }: SpanBarProps) {
  const t = useTheme();
  const isError = span.status?.code === "ERROR";
  const status = piStatusOf(span);
  const isRunning = status === "running";
  const barColor = isError
    ? t.barErrorColor
    : paletteColor(stringAttr(span, "service.name"), t.barPalette);

  // Prompts and Tool calls are containers for the markers folded onto them, not
  // work with a duration of their own. Their bar would just sit behind the dots,
  // spanning first marker to last and implying an activity that never happened.
  if (row.events?.length) return null;

  if (status === "queued") {
    // A queued agent has no duration yet. Show a fixed-width placeholder
    // centred on its start rather than a hairline bar at the minimum width.
    return (
      <div
        style={{
          border: `1.5px dashed ${barColor}`,
          borderRadius: 2,
          bottom: 0,
          left: "50%",
          opacity: 0.5,
          position: "absolute",
          top: 0,
          transform: "translateX(-50%)",
          width: 8,
        }}
      />
    );
  }

  return (
    <div
      style={{
        background: isRunning
          ? `linear-gradient(90deg, ${barColor} 25%, rgba(255,255,255,0.55) 50%, ${barColor} 75%)`
          : barColor,
        backgroundSize: isRunning ? "200% 100%" : undefined,
        animation: isRunning ? "span-shimmer 1.6s linear infinite" : undefined,
        borderRadius: 2,
        height: "100%",
        width: "100%",
      }}
    />
  );
}

function formatTimestamp(nano: string): string {
  const ms = Number(nano) / 1_000_000;
  const d = new Date(ms);
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function formatDuration(startNano: string, endNano: string): string {
  const ms = (Number(endNano) - Number(startNano)) / 1_000_000;
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function AttrRow({
  label,
  mono,
  value,
}: {
  label: string;
  mono?: boolean;
  value: string;
}) {
  return (
    <div className="flex gap-2 text-xs">
      <span
        className="text-muted-foreground shrink-0 w-28 truncate"
        title={label}
      >
        {label}
      </span>
      <span className={`flex-1 break-all ${mono ? "font-mono" : ""}`}>
        {value}
      </span>
    </div>
  );
}

function guessParamLanguage(
  toolName: string | undefined,
  key: string,
): BundledLanguage | null {
  if (toolName === "workflow" && key === "script") return "javascript";
  if (toolName === "bash" && key === "command") return "bash";
  return null;
}

function ParamValue({
  paramKey,
  toolName,
  value,
}: {
  paramKey: string;
  toolName?: string;
  value: string;
}) {
  const lang = guessParamLanguage(toolName, paramKey);
  const isMultiline = value.includes("\n");

  if (lang) {
    return (
      <div className="mt-1 overflow-hidden rounded border text-xs">
        <CodeBlockContent code={value} language={lang} />
      </div>
    );
  }

  if (isMultiline) {
    return (
      <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all rounded border p-2 font-mono text-xs">
        {value}
      </pre>
    );
  }

  return <span className="flex-1 break-all font-mono text-xs">{value}</span>;
}

function MarkdownBlock({ children }: { children: string }) {
  return (
    <div className="rounded border p-2 text-xs overflow-y-auto max-h-64 prose prose-sm prose-invert max-w-none leading-relaxed">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}

function StatusMessage({ message }: { message: string }) {
  let content = message.replace(/`([^`]*)`/g, "$1");
  let lang: BundledLanguage | null = null;
  try {
    content = JSON.stringify(JSON.parse(message), null, 2);
    lang = "json";
  } catch {
    // not JSON — render as plain text
  }
  if (lang) {
    return (
      <div className="mt-1 overflow-hidden rounded border text-xs">
        <CodeBlockContent code={content} language={lang} />
      </div>
    );
  }
  return (
    <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-all rounded border p-2 font-mono text-xs text-muted-foreground">
      {content}
    </pre>
  );
}

/**
 * The markers folded into this row (messages and tool calls), oldest first —
 * buildSpanTree already sorts every child list by start time.
 */
function foldedEvents(span: SpanNode | null): SpanNode[] {
  return (span?.children ?? []).filter((child) => child.kind === "EVENT");
}

/**
 * The model's reasoning for a turn. Collapsed by default: it is context for
 * why a turn went the way it did, not the turn itself, and it is often longer
 * than the response it explains.
 */
function ThinkingBlock({ children }: { children: string }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide hover:text-foreground transition-colors [&[data-state=open]>svg:last-child]:rotate-180">
        <BrainIcon className="size-3.5" />
        Thinking
        <ChevronDownIcon className="size-3.5 transition-transform" />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 border-l-2 border-muted pl-3 text-muted-foreground">
        <MarkdownBlock>{children}</MarkdownBlock>
      </CollapsibleContent>
    </Collapsible>
  );
}

function SpanDetailDrawer({
  onClose,
  span,
}: {
  onClose: () => void;
  span: SpanNode | null;
}) {
  const service = span ? stringAttr(span, "service.name") : undefined;
  const duration = span
    ? formatDuration(span.startTimeUnixNano, span.endTimeUnixNano)
    : null;
  const isEvent = span?.kind === "EVENT";
  const statusCode = span?.status?.code;
  const toolName = span ? stringAttr(span, "pi.tool_name") : undefined;
  const allAttrs = span ? Object.entries(span.attributes ?? {}) : [];
  const params = allAttrs
    .filter(([k]) => k.startsWith("pi.param."))
    .map(([k, v]) => [k.slice("pi.param.".length), v] as [string, unknown]);
  const workflowDescription = span
    ? stringAttr(span, "workflow.description")
    : undefined;
  const piText = span ? stringAttr(span, "pi.text") : undefined;
  const piResult = span ? stringAttr(span, "pi.result") : undefined;
  const piThinking = span ? stringAttr(span, "pi.thinking") : undefined;
  const attrs = allAttrs.filter(
    ([k]) =>
      !k.startsWith("pi.param.") &&
      !["workflow.description", "pi.text", "pi.result", "pi.thinking"].includes(
        k,
      ),
  );
  const resourceAttrs = span ? Object.entries(span.resource ?? {}) : [];
  const events = foldedEvents(span);
  const spanStart = span ? Number(span.startTimeUnixNano) : 0;

  return (
    <Drawer
      modal={false}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      open={span !== null}
      swipeDirection="right"
    >
      <DrawerContent
        className="flex flex-col overflow-hidden"
        style={{ "--drawer-content-width": "320px" } as React.CSSProperties}
      >
        <DrawerHeader className="flex flex-row items-start justify-between gap-2 pb-3">
          <DrawerTitle className="truncate text-sm">
            {span?.name ?? ""}
          </DrawerTitle>
          <DrawerClose className="shrink-0 rounded-sm p-1 opacity-70 hover:opacity-100">
            <XIcon className="size-4" />
            <span className="sr-only">Close</span>
          </DrawerClose>
        </DrawerHeader>
        <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4 space-y-4">
          <div className="space-y-1.5">
            {workflowDescription && (
              <AttrRow label="description" value={workflowDescription} />
            )}
            {span && (
              <AttrRow
                label="time"
                mono
                value={formatTimestamp(span.startTimeUnixNano)}
              />
            )}
            {service && <AttrRow label="service" value={service} />}
            {duration && !isEvent && (
              <AttrRow label="duration" value={duration} />
            )}
            {statusCode && statusCode !== "UNSET" && (
              <div className="flex gap-2 text-xs items-start">
                <span className="text-muted-foreground shrink-0 w-28">
                  status
                </span>
                <div className="flex-1 min-w-0">
                  <span
                    className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${
                      statusCode === "ERROR"
                        ? "bg-destructive/15 text-destructive"
                        : "bg-green-500/15 text-green-600 dark:text-green-400"
                    }`}
                  >
                    {statusCode === "ERROR" ? "Failed" : "Success"}
                  </span>
                  {span?.status?.message && (
                    <StatusMessage message={span.status.message} />
                  )}
                </div>
              </div>
            )}
            {span?.kind && span.kind !== "UNSPECIFIED" && (
              <AttrRow label="kind" value={span.kind} />
            )}
          </div>
          {piThinking && <ThinkingBlock>{piThinking}</ThinkingBlock>}
          {piText && (
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                Prompt
              </p>
              <MarkdownBlock>{piText}</MarkdownBlock>
            </div>
          )}
          {piResult && (
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                Result
              </p>
              <MarkdownBlock>{piResult}</MarkdownBlock>
            </div>
          )}
          {events.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                Events ({events.length})
              </p>
              <div className="space-y-1.5">
                {events.map((event) => (
                  <AttrRow
                    key={event.spanId}
                    label={formatDuration(
                      String(spanStart),
                      event.startTimeUnixNano,
                    )}
                    value={event.name}
                  />
                ))}
              </div>
            </div>
          )}
          {params.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                Parameters
              </p>
              <div className="space-y-3">
                {params.map(([key, value]) => {
                  const strVal = String(value);
                  const lang = guessParamLanguage(toolName, key);
                  const isMultiline = strVal.includes("\n");
                  if (lang || isMultiline) {
                    return (
                      <div key={key}>
                        <p className="text-xs text-muted-foreground mb-1">
                          {key}
                        </p>
                        <ParamValue
                          paramKey={key}
                          toolName={toolName}
                          value={strVal}
                        />
                      </div>
                    );
                  }
                  return <AttrRow key={key} label={key} mono value={strVal} />;
                })}
              </div>
            </div>
          )}
          {attrs.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                Attributes
              </p>
              <div className="space-y-1.5">
                {attrs.map(([key, value]) => (
                  <AttrRow key={key} label={key} mono value={String(value)} />
                ))}
              </div>
            </div>
          )}
          {resourceAttrs.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                Resource
              </p>
              <div className="space-y-1.5">
                {resourceAttrs.map(([key, value]) => (
                  <AttrRow key={key} label={key} mono value={String(value)} />
                ))}
              </div>
            </div>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
}

export type TimelineMode = "fit" | "follow";

export function SessionWorkflowPanel({
  messages,
  onAgentClick,
  sessionId,
  sessionRunning,
  snapshot,
  timelineMode,
  onTimelineModeChange,
  toolCalls,
  workflowRuns,
}: {
  messages?: SessionMessage[];
  onAgentClick?: (agentId: number, runId: string) => void;
  sessionId?: string;
  sessionRunning?: boolean;
  snapshot?: WorkflowSnapshot;
  /** Controlled timeline mode. Omit to let the panel manage it internally. */
  timelineMode?: TimelineMode;
  /** Fired when the internal mode changes (only relevant when timelineMode is uncontrolled). */
  onTimelineModeChange?: (mode: TimelineMode) => void;
  toolCalls?: SessionToolCall[];
  workflowRuns?: WorkflowRun[];
}) {
  const [expanded, _setExpanded] = useState(false);
  const [viewMode, setViewMode] = useState<"graph" | "timeline">("timeline");
  const [selectedSpan, setSelectedSpan] = useState<SpanNode | null>(null);
  const [liveNow, setLiveNow] = useState(() => Date.now());

  // Timeline mode — controlled if prop is provided, otherwise internal.
  const [internalTimelineMode, setInternalTimelineMode] =
    useState<TimelineMode>("fit");
  const effectiveMode = timelineMode ?? internalTimelineMode;
  const setEffectiveMode = useCallback(
    (m: TimelineMode) => {
      setInternalTimelineMode(m);
      onTimelineModeChange?.(m);
    },
    [onTimelineModeChange],
  );

  // Whether the waterfall's live-tracking is currently active.
  // Both Fit and Follow use liveMode=true; user panning deactivates it.
  const [liveActive, setLiveActive] = useState(true);

  // Capture library button functions. useCallback gives stable component identity
  // so TraceWaterfall doesn't remount the slot on re-render.
  const fitFnRef = useRef<(() => void) | null>(null);
  const FitButtonCapture = useCallback(({ onClick }: FitButtonProps) => {
    fitFnRef.current = onClick;
    return null;
  }, []);

  const followFnRef = useRef<(() => void) | null>(null);
  const FollowButtonCapture = useCallback(({ onClick }: FollowButtonProps) => {
    followFnRef.current = onClick;
    return null;
  }, []);

  const handleFit = useCallback(() => {
    fitFnRef.current?.();
    setEffectiveMode("fit");
    setLiveActive(true);
  }, [setEffectiveMode]);

  const handleFollow = useCallback(() => {
    followFnRef.current?.();
    setEffectiveMode("follow");
    setLiveActive(true);
  }, [setEffectiveMode]);

  const handleLiveModeChange = useCallback((isLive: boolean) => {
    if (!isLive) setLiveActive(false);
  }, []);

  const hasActiveAgents =
    (snapshot?.runningCount ?? 0) > 0 ||
    (snapshot?.agents ?? []).some((a) => a.status === "queued");

  useEffect(() => {
    if (!hasActiveAgents) return;
    const id = setInterval(() => setLiveNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [hasActiveAgents]);

  const { edges, nodes: computedNodes } = useMemo(() => {
    if (!snapshot) {
      return { edges: [], nodes: [] };
    }

    const phases = snapshot.phases.length > 0 ? snapshot.phases : ["Workflow"];

    // Group agents by phase, preserving insertion order within each phase.
    const agentsByPhase = new Map<string, WorkflowAgentSnapshot[]>(
      phases.map((p) => [p, []]),
    );
    for (const agent of snapshot.agents) {
      const key = agent.phase ?? phases[0];
      if (!agentsByPhase.has(key)) {
        agentsByPhase.set(key, []);
      }
      agentsByPhase.get(key)!.push(agent);
    }

    const flowNodes: FlowNode[] = [];
    const phaseEdges: FlowEdge[] = [];

    const runId = snapshot.runId;

    // Add an orchestrator root node for real multi-phase workflows.
    const hasNamedPhases = snapshot.phases.length > 0;
    if (hasNamedPhases) {
      const firstPhaseAgents = agentsByPhase.get(phases[0]) ?? [];
      const orchestratorY = Math.max(
        0,
        ((firstPhaseAgents.length - 1) * ROW_HEIGHT) / 2,
      );
      flowNodes.push({
        data: { name: snapshot.name },
        id: "orchestrator",
        position: { x: -COL_WIDTH, y: orchestratorY },
        type: "orchestrator",
      });
    }

    phases.forEach((phase, colIndex) => {
      const colAgents = agentsByPhase.get(phase) ?? [];
      const x = colIndex * COL_WIDTH;

      if (colAgents.length === 0) {
        flowNodes.push({
          data: { onAgentClick, phase, runId } as WorkflowNodeData,
          id: `phase-${phase}`,
          position: { x, y: 0 },
          type: "agent",
        });
      } else {
        colAgents.forEach((agent, rowIndex) => {
          flowNodes.push({
            data: { agent, onAgentClick, phase, runId },
            id: `agent-${agent.id}`,
            position: { x, y: rowIndex * ROW_HEIGHT },
            type: "agent",
          });
        });
      }

      if (colIndex === 0 && hasNamedPhases) {
        // Orchestrator → all first-phase agents.
        const targetIds =
          colAgents.length > 0
            ? colAgents.map((a) => `agent-${a.id}`)
            : [`phase-${phase}`];
        for (const targetId of targetIds) {
          phaseEdges.push({
            animated: false,
            id: `orchestrator-${targetId}`,
            source: "orchestrator",
            target: targetId,
            type: "animated",
          });
        }
      }

      if (colIndex > 0) {
        const prevPhase = phases[colIndex - 1];
        const prevColAgents = agentsByPhase.get(prevPhase) ?? [];

        // Many-to-many edges so every parallel agent in the previous phase
        // visibly connects to every agent in the next phase.
        const sourceIds =
          prevColAgents.length > 0
            ? prevColAgents.map((a) => `agent-${a.id}`)
            : [`phase-${prevPhase}`];
        const targetIds =
          colAgents.length > 0
            ? colAgents.map((a) => `agent-${a.id}`)
            : [`phase-${phase}`];

        for (const sourceId of sourceIds) {
          for (const targetId of targetIds) {
            phaseEdges.push({
              animated: snapshot.currentPhase === prevPhase,
              id: `${sourceId}-${targetId}`,
              source: sourceId,
              target: targetId,
              type: "animated",
            });
          }
        }
      }
    });

    return { edges: phaseEdges, nodes: flowNodes };
  }, [snapshot, onAgentClick]);

  // Keep node positions stable across snapshot updates so dragging persists.
  // Positions reset only when a node is new; status/data updates are merged in.
  const [nodes, setNodes, onNodesChange] =
    useNodesState<FlowNode>(computedNodes);
  useEffect(() => {
    setNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]));
      return computedNodes.map((newNode) => {
        const existing = prevById.get(newNode.id);
        return existing ? { ...newNode, position: existing.position } : newNode;
      });
    });
  }, [computedNodes, setNodes]);

  if (!snapshot) {
    return (
      <section className="overflow-hidden rounded-lg border bg-sidebar">
        <div className="flex items-center border-b bg-card px-4 py-3">
          <div>
            <h2 className="font-medium">Agents</h2>
            <p className="text-muted-foreground text-sm">No workflow running</p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <div className="relative h-[200px]">
      <section
        className="flex flex-col overflow-hidden rounded-lg border bg-sidebar transition-[height] duration-200"
        style={{
          zIndex: 50,
        }}
      >
        <div className="flex-none flex items-center justify-between border-b bg-card px-4 py-3">
          <div className="flex items-center min-w-0">
            <h2 className="font-medium mr-4 truncate">{snapshot.name}</h2>
            <p className="text-muted-foreground text-sm shrink-0">
              {snapshot.doneCount}/{snapshot.agentCount} agents complete
              {snapshot.tokenUsage?.total ? " · " : ""}
              <TokenUsage
                cost={snapshot.tokenUsage?.cost}
                tokens={snapshot.tokenUsage?.total}
              />
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {snapshot.runningCount > 0 && (
              <span className="text-primary text-sm">
                {snapshot.runningCount} running
              </span>
            )}
            {viewMode === "timeline" && (
              <div className="flex items-center gap-1 rounded border border-border/50 p-0.5">
                <button
                  aria-label="Fit all spans in view"
                  aria-pressed={effectiveMode === "fit" && liveActive}
                  className={`rounded px-2 py-0.5 text-xs transition-colors ${
                    effectiveMode === "fit" && liveActive
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  onClick={handleFit}
                >
                  Fit
                </button>
                <button
                  aria-label="Follow new events at current zoom"
                  aria-pressed={effectiveMode === "follow" && liveActive}
                  className={`rounded px-2 py-0.5 text-xs transition-colors ${
                    effectiveMode === "follow" && liveActive
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  onClick={handleFollow}
                >
                  Follow
                </button>
              </div>
            )}
            <button
              aria-label={
                viewMode === "timeline"
                  ? "Switch to graph view"
                  : "Switch to timeline view"
              }
              className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              onClick={() =>
                setViewMode((v) => (v === "timeline" ? "graph" : "timeline"))
              }
            >
              {viewMode === "timeline" ? (
                <NetworkIcon className="size-3.5" />
              ) : (
                <GanttChartIcon className="size-3.5" />
              )}
            </button>
          </div>
        </div>
        <div className="flex-1 min-h-0">
          {viewMode === "timeline" ? (
            <>
              <style>{SHIMMER_STYLE}</style>
              <TraceWaterfall
                resetKey={`${sessionId ?? ""}-${snapshot.runId ?? "no-run"}`}
                spans={workflowSnapshotToSpans(snapshot, messages ?? [], {
                  now: liveNow,
                  sessionRunning,
                  toolCalls,
                  // flatMap rather than filter+map so the null snapshots are
                  // narrowed out for the type checker, not just at runtime.
                  additionalSnapshots: workflowRuns?.flatMap((r) =>
                    r.run_id !== snapshot.runId && r.snapshot?.runId
                      ? [r.snapshot]
                      : [],
                  ),
                })}
                height={240}
                theme={TIMELINE_THEME}
                liveMode={liveActive}
                onLiveModeChange={handleLiveModeChange}
                initialState="expanded"
                clampZoomToBounds
                // Messages and tool calls are EVENT spans under Conversation; fold
                // them onto that one row as markers instead of a row each.
                foldEventsIntoParent
                timelinePadding={10}
                FitButtonComponent={FitButtonCapture}
                FollowButtonComponent={FollowButtonCapture}
                followMode={effectiveMode === "follow" ? "follow-end" : "fit"}
                SpanNameComponent={SpanName}
                SpanBarComponent={SpanBar}
                TooltipComponent={InlineEventTooltip}
                // We render our own panel below, so switch the built-in one off
                // rather than showing both. Ours also portals to the body, which
                // the 260px overflow-auto inspect container would otherwise clip.
                disableInspectPanel
                onSelectSpan={(span: SpanNode | null) => {
                  if (!span) {
                    setSelectedSpan(null);
                    return;
                  }
                  // Agent rows have a richer drawer of their own (the transcript).
                  const agentId = numberAttr(span, "pi.agent_id");
                  const runId = stringAttr(span, "pi.run_id");
                  if (
                    onAgentClick &&
                    agentId !== undefined &&
                    runId !== undefined
                  ) {
                    onAgentClick(agentId, runId);
                    return;
                  }
                  // Conversation markers name the transcript entry they came
                  // from, so selecting one scrolls the chat to it.
                  const msgId = stringAttr(span, "msg_id");
                  if (msgId) {
                    document
                      .getElementById(msgId)
                      ?.scrollIntoView({ behavior: "smooth", block: "center" });
                  }
                  setSelectedSpan((prev) =>
                    prev?.spanId === span.spanId ? null : span,
                  );
                }}
              />
            </>
          ) : (
            <Canvas
              edges={edges}
              edgeTypes={edgeTypes}
              fitViewOptions={{ padding: 0.25 }}
              nodeTypes={nodeTypes}
              nodes={nodes}
              nodesDraggable
              nodesFocusable={false}
              onNodesChange={onNodesChange}
              panOnDrag
            >
              <FitViewOnChange expanded={expanded} nodeCount={nodes.length} />
              <Controls showInteractive={false} />
            </Canvas>
          )}
        </div>
      </section>
      <SpanDetailDrawer
        onClose={() => setSelectedSpan(null)}
        span={selectedSpan}
      />
    </div>
  );
}
