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
import { TraceWaterfall, darkTheme, useTheme } from "react-otel-trace-waterfall";
import type { SpanNode, SpanComponentProps } from "react-otel-trace-waterfall";
import { workflowSnapshotToSpans } from "@/lib/workflow-spans";
import { useNodesState, useReactFlow } from "@xyflow/react";
import { GanttChartIcon, NetworkIcon, XIcon } from "lucide-react";
import type { SpanTooltipProps } from "react-otel-trace-waterfall";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Spinner } from "@/components/ui/spinner";
import { TokenUsage } from "@/components/token-usage";
import { CodeBlockContent } from "@/components/ai-elements/code/code-block";
import type { BundledLanguage } from "shiki";

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
      fitView({ duration: 300, padding: 0.25 });
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

// ── Inline span row ──────────────────────────────────────────────────────────
// Shared constants that mirror the library's internal layout values.
const LABEL_COL = 280;
const SPAN_ROW_H = 32;
const BAR_H = 14;
const MIN_BAR_W = 2;
/** Extra clickable pixels on each side of a bar, so narrow bars stay aimable. */
const BAR_HIT_PAD = 4;

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

function InlineSpanRow({
  row,
  scale,
  isSelected,
  isFocused,
  onToggle,
  onSelect,
  onHoverEvent,
}: SpanComponentProps) {
  const { span, hasChildren, isExpanded } = row;
  const t = useTheme();
  const isError = span.status?.code === "ERROR";
  const isRunning = span.attributes?.["pi.status"] === "running";
  const isQueued = span.attributes?.["pi.status"] === "queued";
  const service = span.resource?.["service.name"] as string | undefined;
  const barColor = isError
    ? t.barErrorColor
    : paletteColor(service, t.barPalette);
  const startPx = scale(Number(span.startTimeUnixNano));
  const endPx = scale(Number(span.endTimeUnixNano));
  const barWidth = Math.max(MIN_BAR_W, endPx - startPx);
  const events = row.events ?? [];
  const indent = span.depth * t.rowIndentPx + t.rowPaddingInline;

  return (
    <div
      role="row"
      style={{
        display: "flex",
        alignItems: "center",
        height: SPAN_ROW_H,
        borderBottom: `1px solid ${t.rowBorder}`,
        background: isSelected ? t.rowSelectedBackground : "transparent",
        boxShadow: isFocused ? `inset 0 0 0 2px ${t.rowFocusRing}` : undefined,
        cursor: "default",
        userSelect: "none",
      }}
      // The waterfall wraps this row in a div that selects on any click, which
      // opened the drawer from anywhere on the row — including empty timeline
      // space. Swallow the click here so only the bar below selects, and so our
      // own onSelect is not doubled by the wrapper's.
      onClick={(e) => e.stopPropagation()}
    >
      <div
        style={{
          width: LABEL_COL,
          flexShrink: 0,
          paddingLeft: indent,
          paddingRight: 6,
          display: "flex",
          alignItems: "center",
          overflow: "hidden",
        }}
      >
        <button
          style={{
            width: 14,
            flexShrink: 0,
            background: "none",
            border: "none",
            padding: 0,
            cursor: hasChildren ? "pointer" : "default",
            color: t.chevronColor,
            fontSize: 10,
            visibility: hasChildren ? "visible" : "hidden",
          }}
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) onToggle(span.spanId);
          }}
        >
          {isExpanded ? "▾" : "▸"}
        </button>
        <span
          style={{
            color: isError ? t.spanNameErrorColor : t.spanNameColor,
            fontSize: 13,
            marginLeft: 4,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
          }}
        >
          {span.name}
        </span>
        {isRunning && (
          <span style={{ flexShrink: 0, marginLeft: 6, opacity: 0.7 }}>
            <Spinner className="size-3" />
          </span>
        )}
        {isQueued && (
          <span
            style={{ flexShrink: 0, marginLeft: 6, opacity: 0.4, fontSize: 10 }}
          >
            ·
          </span>
        )}
      </div>
      <div
        style={{
          flex: 1,
          position: "relative",
          overflow: "hidden",
          height: "100%",
        }}
      >
        {events.length === 0 && (
          // Full-height hit area a few pixels wider than the bar: a bar can be
          // as narrow as MIN_BAR_W, which is too small to aim at.
          <div
            onClick={(e) => {
              e.stopPropagation();
              onSelect(span.spanId);
            }}
            style={{
              position: "absolute",
              left: (isQueued ? startPx - 4 : startPx) - BAR_HIT_PAD,
              width: (isQueued ? 8 : barWidth) + BAR_HIT_PAD * 2,
              top: 0,
              bottom: 0,
              cursor: "pointer",
            }}
          >
            <div
              style={{
                position: "absolute",
                left: BAR_HIT_PAD,
                width: isQueued ? 8 : barWidth,
                height: BAR_H,
                top: "50%",
                transform: "translateY(-50%)",
                background: isQueued ? "transparent" : barColor,
                border: isQueued ? `1.5px dashed ${barColor}` : "none",
                borderRadius: 2,
                opacity: isQueued ? 0.5 : 1,
              }}
            />
          </div>
        )}
        {events.map((ev) => {
          const evService = ev.resource?.["service.name"] as string | undefined;
          const color = ev.status?.code === "ERROR"
            ? t.barErrorColor
            : evService
              ? paletteColor(evService, t.barPalette)
              : t.eventMarkerColor || barColor;
          const msgId = ev.attributes?.["msg_id"] as string | undefined;
          return (
            <div
              key={ev.spanId}
              style={{
                position: "absolute",
                left: scale(Number(ev.startTimeUnixNano)),
                top: "50%",
                transform: "translate(-50%, -50%)",
                width: t.eventMarkerSize,
                height: t.eventMarkerSize,
                background: color,
                borderRadius: "50%",
                cursor: "pointer",
                zIndex: 1,
              }}
              onMouseEnter={() => onHoverEvent(ev)}
              onMouseLeave={() => onHoverEvent(null)}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(ev.spanId);
                if (msgId)
                  document
                    .getElementById(msgId)
                    ?.scrollIntoView({ behavior: "smooth", block: "center" });
              }}
            />
          );
        })}
      </div>
    </div>
  );
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

  return (
    <span className="flex-1 break-all font-mono text-xs">{value}</span>
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

function SpanDetailDrawer({
  onClose,
  span,
}: {
  onClose: () => void;
  span: SpanNode | null;
}) {
  const service = span?.resource?.["service.name"] as string | undefined;
  const duration = span
    ? formatDuration(span.startTimeUnixNano, span.endTimeUnixNano)
    : null;
  const statusCode = span?.status?.code;
  const toolName = span?.attributes?.["pi.tool_name"] as string | undefined;
  const allAttrs = span ? Object.entries(span.attributes ?? {}) : [];
  const params = allAttrs
    .filter(([k]) => k.startsWith("pi.param."))
    .map(([k, v]) => [k.slice("pi.param.".length), v] as [string, unknown]);
  const workflowDescription = span?.attributes?.["workflow.description"] as string | undefined;
  const attrs = allAttrs.filter(([k]) => !k.startsWith("pi.param.") && k !== "workflow.description");
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
            {service && <AttrRow label="service" value={service} />}
            {duration && <AttrRow label="duration" value={duration} />}
            {statusCode && statusCode !== "UNSET" && (
              <div className="flex gap-2 text-xs items-start">
                <span className="text-muted-foreground shrink-0 w-28">status</span>
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
                        <p className="text-xs text-muted-foreground mb-1">{key}</p>
                        <ParamValue paramKey={key} toolName={toolName} value={strVal} />
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

export function SessionWorkflowPanel({
  messages,
  onAgentClick,
  sessionId,
  sessionRunning,
  snapshot,
  toolCalls,
}: {
  messages?: SessionMessage[];
  onAgentClick?: (agentId: number, runId: string) => void;
  sessionId?: string;
  sessionRunning?: boolean;
  snapshot?: WorkflowSnapshot;
  toolCalls?: SessionToolCall[];
}) {
  const [expanded, setExpanded] = useState(false);
  const [viewMode, setViewMode] = useState<"graph" | "timeline">("timeline");
  const [selectedSpan, setSelectedSpan] = useState<SpanNode | null>(null);
  const [liveNow, setLiveNow] = useState(() => Date.now());

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
            <TraceWaterfall
              key={`${sessionId ?? ""}-${snapshot.runId ?? "no-run"}`}
              spans={workflowSnapshotToSpans(snapshot, messages ?? [], {
                now: liveNow,
                sessionRunning,
                toolCalls,
              })}
              height={240}
              theme={darkTheme}
              liveMode={snapshot.runningCount > 0}
              initialState="expanded"
              clampZoomToBounds
              // Messages and tool calls are EVENT spans under Conversation; fold
              // them onto that one row as markers instead of a row each.
              foldEventsIntoParent
              timelinePadding={10}
              SpanComponent={InlineSpanRow}
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
                const agentId = span.attributes?.["pi.agent_id"];
                const runId = span.attributes?.["pi.run_id"];
                if (
                  onAgentClick &&
                  typeof agentId === "number" &&
                  typeof runId === "string"
                ) {
                  onAgentClick(agentId, runId);
                  return;
                }
                setSelectedSpan((prev) =>
                  prev?.spanId === span.spanId ? null : span,
                );
              }}
            />
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
