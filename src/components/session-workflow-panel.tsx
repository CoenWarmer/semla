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
import type { WorkflowAgentSnapshot, WorkflowSnapshot } from "@/types/workflow";
import type {
  Edge as FlowEdge,
  Node as FlowNode,
  NodeProps,
} from "@xyflow/react";
import { useNodesState, useReactFlow } from "@xyflow/react";
import { Maximize2Icon, Minimize2Icon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

function FitViewOnChange({ expanded, nodeCount }: { expanded: boolean; nodeCount: number }) {
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
      const id = setTimeout(() => fitView({ duration: 300, padding: 0.25 }), 220);
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
          {agent.tokens
            ? `${agent.tokens.toLocaleString()} tokens`
            : "No usage reported"}
        </NodeFooter>
      )}
    </WorkflowNode>
  );
};

const nodeTypes = { agent: AgentNode, orchestrator: OrchestratorNode };
const edgeTypes = { animated: Edge.Animated };

const COL_WIDTH = 440;
const ROW_HEIGHT = 200;

export function SessionWorkflowPanel({
  onAgentClick,
  snapshot,
}: {
  onAgentClick?: (agentId: number, runId: string) => void;
  snapshot?: WorkflowSnapshot;
}) {
  const [expanded, setExpanded] = useState(false);
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
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(computedNodes);
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
        style={
          expanded
            ? {
                position: "absolute",
                inset: "0 0 auto",
                height: "min(60dvh, 600px)",
                zIndex: 50,
              }
            : { height: "200px" }
        }
      >
        <div className="flex-none flex items-center justify-between border-b bg-card px-4 py-3">
          <div className="flex items-center min-w-0">
            <h2 className="font-medium mr-4 truncate">{snapshot.name}</h2>
            <p className="text-muted-foreground text-sm shrink-0">
              {snapshot.doneCount}/{snapshot.agentCount} agents complete
              {snapshot.tokenUsage?.total
                ? ` · ${snapshot.tokenUsage.total.toLocaleString()} tokens`
                : ""}
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
                expanded ? "Collapse workflow panel" : "Expand workflow panel"
              }
              className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? (
                <Minimize2Icon className="size-3.5" />
              ) : (
                <Maximize2Icon className="size-3.5" />
              )}
            </button>
          </div>
        </div>
        <div className="flex-1 min-h-0">
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
        </div>
      </section>
    </div>
  );
}
