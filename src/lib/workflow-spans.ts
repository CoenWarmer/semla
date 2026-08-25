import type { OtelSpan } from "react-otel-trace-waterfall";
import type { SessionMessage, SessionToolCall } from "@/hooks/use-session-messages";
import type { WorkflowSnapshot } from "@/types/workflow";

function msToNano(ms: number): string {
  // Multiply milliseconds by 1,000,000 using string math to avoid BigInt (tsconfig target < ES2020).
  const whole = Math.round(ms);
  const zeros = "000000";
  return `${whole}${zeros}`;
}

// Deterministic 16-char hex span ID from a string key.
function makeSpanId(key: string): string {
  let h = 5381;
  for (let i = 0; i < key.length; i++) {
    h = (Math.imul(h, 33) ^ key.charCodeAt(i)) >>> 0;
  }
  // Two rounds to get 16 hex chars.
  let h2 = 5381;
  for (let i = key.length - 1; i >= 0; i--) {
    h2 = (Math.imul(h2, 33) ^ key.charCodeAt(i)) >>> 0;
  }
  return (h.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).slice(0, 16);
}

// Fixed trace ID — all synthesized spans belong to one trace per page load.
const TRACE_ID = "73656d6c61736573730000000000006f"; // "semlasess....o" padded to 32

/**
 * Convert a WorkflowSnapshot + conversation messages into OtelSpan[]
 * suitable for react-otel-trace-waterfall. No real OTel backend required —
 * spans are synthesised from what we already have.
 *
 * Hierarchy:
 *   Session (root)
 *   ├── Conversation
 *   │   ├── user: …
 *   │   └── assistant: …
 *   └── <workflow name>         (only when snapshot.runId is set)
 *       └── <phase>
 *           └── <agent>
 */
export function workflowSnapshotToSpans(
  snapshot: WorkflowSnapshot,
  messages: SessionMessage[],
  options?: {
    sessionRunning?: boolean;
    now?: number;
    toolCalls?: SessionToolCall[];
    additionalSnapshots?: WorkflowSnapshot[];
  },
): OtelSpan[] {
  const now = options?.now ?? Date.now();
  const toolCalls = options?.toolCalls ?? [];
  const additionalSnapshots = options?.additionalSnapshots ?? [];
  const spans: OtelSpan[] = [];

  // ── Gather all timestamps to compute trace bounds ───────────────────────
  const allSnapshots = [snapshot, ...additionalSnapshots];
  const agentMs = allSnapshots.flatMap((s) =>
    s.agents
      .filter((a) => a.startedAt)
      .flatMap((a) => [
        new Date(a.startedAt!).getTime(),
        a.endedAt ? new Date(a.endedAt).getTime() : now,
      ]),
  );
  const msgMs = messages
    .filter((m) => m.text.trim().length > 0)
    .map((m) => new Date(m.createdAt).getTime());
  const toolMs = toolCalls.flatMap((call) => [
    new Date(call.createdAt).getTime(),
    ...(call.resultAt ? [new Date(call.resultAt).getTime()] : []),
  ]);
  const hasActive = allSnapshots.some((s) =>
    s.agents.some((a) => a.status === "running" || a.status === "queued"),
  );
  const allMs = [...agentMs, ...msgMs, ...toolMs, ...(hasActive ? [now] : [])];

  if (allMs.length === 0) return [];

  const traceStart = Math.min(...allMs);
  const traceEnd = Math.max(...allMs);

  // ── Session root ─────────────────────────────────────────────────────────
  const sessionId = makeSpanId("session");
  spans.push({
    traceId: TRACE_ID,
    spanId: sessionId,
    name: "Session",
    startTimeUnixNano: msToNano(traceStart),
    endTimeUnixNano: msToNano(traceEnd),
    resource: { "service.name": "session" },
    kind: "INTERNAL",
    attributes: options?.sessionRunning ? { "pi.status": "running" } : undefined,
  });

  // ── Conversation branch ───────────────────────────────────────────────────
  // Each agent gets two sub-rows: Prompts (messages) and Tool calls.
  const visibleMessages = messages.filter((m) => m.text.trim().length > 0);
  if (visibleMessages.length > 0 || toolCalls.length > 0) {
    const convMs = [...msgMs, ...toolMs];
    const convStart = Math.min(...convMs);
    const convEnd = Math.max(...convMs);
    const convId = makeSpanId("conversation");
    spans.push({
      traceId: TRACE_ID,
      spanId: convId,
      parentSpanId: sessionId,
      name: "Conversation",
      startTimeUnixNano: msToNano(convStart),
      endTimeUnixNano: msToNano(convEnd + 1),
      resource: { "service.name": "session" },
      kind: "INTERNAL",
    });

    // ── Prompts sub-row ──────────────────────────────────────────────────
    if (visibleMessages.length > 0) {
      const promptsStart = Math.min(...msgMs);
      const promptsEnd = Math.max(...msgMs);
      const promptsId = makeSpanId("conversation-prompts");
      spans.push({
        traceId: TRACE_ID,
        spanId: promptsId,
        parentSpanId: convId,
        name: "Prompts",
        startTimeUnixNano: msToNano(promptsStart),
        endTimeUnixNano: msToNano(promptsEnd + 1),
        resource: { "service.name": "session" },
        kind: "INTERNAL",
      });

      for (const msg of visibleMessages) {
        const t = new Date(msg.createdAt).getTime();
        const nano = msToNano(t);
        spans.push({
          traceId: TRACE_ID,
          spanId: makeSpanId(`msg-${msg.id}`),
          parentSpanId: promptsId,
          name: msg.role === "user" ? "↑ User" : "↓ Assistant",
          startTimeUnixNano: nano,
          endTimeUnixNano: nano,
          kind: "EVENT",
          attributes: { msg_id: msg.id, "pi.text": msg.text.trim() },
          resource: { "service.name": msg.role === "user" ? "user" : "assistant" },
        });
      }
    }

    // ── Tool calls sub-row ───────────────────────────────────────────────
    if (toolCalls.length > 0) {
      const toolsStart = Math.min(...toolMs);
      const toolsEnd = Math.max(...toolMs);
      const toolsId = makeSpanId("conversation-toolcalls");
      spans.push({
        traceId: TRACE_ID,
        spanId: toolsId,
        parentSpanId: convId,
        name: "Tool calls",
        startTimeUnixNano: msToNano(toolsStart),
        endTimeUnixNano: msToNano(toolsEnd + 1),
        resource: { "service.name": "tool" },
        kind: "INTERNAL",
      });

      for (const call of toolCalls) {
        const nano = msToNano(new Date(call.createdAt).getTime());
        const paramAttrs = call.params
          ? Object.fromEntries(Object.entries(call.params).map(([k, v]) => [`pi.param.${k}`, v]))
          : {};
        spans.push({
          traceId: TRACE_ID,
          spanId: makeSpanId(`tool-${call.id}`),
          parentSpanId: toolsId,
          name: call.summary ? `⚙ ${call.name}: ${call.summary}` : `⚙ ${call.name}`,
          startTimeUnixNano: nano,
          endTimeUnixNano: nano,
          kind: "EVENT",
          attributes: { msg_id: call.messageId, "pi.tool_name": call.name, ...paramAttrs },
          status: call.isError !== undefined
            ? (call.isError
                ? { code: "ERROR", message: call.errorText }
                : { code: "OK" })
            : undefined,
          resource: { "service.name": "tool" },
        });

        if (call.resultAt) {
          const resultNano = msToNano(new Date(call.resultAt).getTime());
          spans.push({
            traceId: TRACE_ID,
            spanId: makeSpanId(`tool-result-${call.id}`),
            parentSpanId: toolsId,
            name: `↩ ${call.name}`,
            startTimeUnixNano: resultNano,
            endTimeUnixNano: resultNano,
            kind: "EVENT",
            attributes: {
              msg_id: call.messageId,
              "pi.tool_name": call.name,
              ...(call.resultText ? { "pi.result": call.resultText } : {}),
            },
            status: call.isError !== undefined
              ? (call.isError ? { code: "ERROR" } : { code: "OK" })
              : undefined,
            resource: { "service.name": "tool-result" },
          });
        }
      }
    }
  }

  // ── Workflow branches — one per run with a runId ────────────────────────
  for (const wfSnapshot of allSnapshots) {
    if (!wfSnapshot.runId) continue;

    const wfStart = wfSnapshot.startedAt
      ? new Date(wfSnapshot.startedAt).getTime()
      : traceStart;
    const wfEnd = wfSnapshot.completedAt
      ? new Date(wfSnapshot.completedAt).getTime()
      : wfSnapshot.runningCount > 0 || wfSnapshot.agents.length === 0
        ? now  // still running (or just starting — no agents yet)
        : traceEnd;

    const wfId = makeSpanId(`wf-${wfSnapshot.runId}`);
    spans.push({
      traceId: TRACE_ID,
      spanId: wfId,
      parentSpanId: sessionId,
      name: wfSnapshot.name,
      startTimeUnixNano: msToNano(wfStart),
      endTimeUnixNano: msToNano(wfEnd),
      attributes: wfSnapshot.description
        ? { "workflow.description": wfSnapshot.description }
        : undefined,
      resource: { "service.name": "workflow" },
      kind: "INTERNAL",
    });

    const phases =
      wfSnapshot.phases.length > 0 ? wfSnapshot.phases : ["Agents"];

    for (const phase of phases) {
      const phaseAgents = wfSnapshot.agents.filter(
        (a) => (a.phase ?? phases[0]) === phase,
      );
      if (!phaseAgents.length) continue;

      const phaseTimes = phaseAgents
        .filter((a) => a.startedAt)
        .flatMap((a) => [
          new Date(a.startedAt!).getTime(),
          a.endedAt ? new Date(a.endedAt).getTime() : now,
        ]);

      const phaseStart = phaseTimes.length > 0 ? Math.min(...phaseTimes) : wfStart;
      const phaseEnd = phaseTimes.length > 0 ? Math.max(...phaseTimes) : wfEnd;
      const phaseId = makeSpanId(`phase-${wfSnapshot.runId}-${phase}`);

      spans.push({
        traceId: TRACE_ID,
        spanId: phaseId,
        parentSpanId: wfId,
        name: phase,
        startTimeUnixNano: msToNano(phaseStart),
        endTimeUnixNano: msToNano(phaseEnd),
        resource: { "service.name": "workflow" },
        kind: "INTERNAL",
      });

      for (const agent of phaseAgents) {
        const aStart = agent.startedAt
          ? new Date(agent.startedAt).getTime()
          : agent.status === "queued"
            ? now
            : phaseStart;
        const aEnd = agent.endedAt
          ? new Date(agent.endedAt).getTime()
          : agent.status === "running" || agent.status === "queued"
            ? now
            : aStart + 1;

        const agentSpanId = makeSpanId(`agent-${agent.id}-${wfSnapshot.runId}`);
        spans.push({
          traceId: TRACE_ID,
          spanId: agentSpanId,
          parentSpanId: phaseId,
          name: agent.label,
          startTimeUnixNano: msToNano(aStart),
          endTimeUnixNano: msToNano(aEnd),
          attributes: {
            "pi.status": agent.status,
            "pi.agent_id": agent.id,
            "pi.run_id": wfSnapshot.runId,
            ...(agent.prompt ? { "pi.user_prompt": agent.prompt.slice(0, 200) } : {}),
            ...(agent.tokens ? { "gen_ai.usage.total_tokens": agent.tokens } : {}),
            ...(agent.error ? { "error.message": agent.error } : {}),
          },
          status: agent.status === "error" ? { code: "ERROR", message: agent.error } : undefined,
          resource: { "service.name": "agent" },
          kind: "INTERNAL",
        });

        const turns = agent.turns ?? [];
        const promptTurns = turns.filter((t) => t.kind === "prompt");
        const toolCallTurns = turns.filter((t) => t.kind === "toolCall");

        if (promptTurns.length > 0) {
          const promptsId = makeSpanId(`agent-${agent.id}-${wfSnapshot.runId}-prompts`);
          spans.push({
            traceId: TRACE_ID,
            spanId: promptsId,
            parentSpanId: agentSpanId,
            name: "Prompts",
            startTimeUnixNano: msToNano(aStart),
            endTimeUnixNano: msToNano(aEnd),
            resource: { "service.name": "session" },
            kind: "INTERNAL",
          });
          for (const turn of promptTurns) {
            // History timestamps are unreliable (all stamped at agent creation).
            // Use agent start for user prompts, agent end for assistant responses.
            const t = turn.role === "assistant" ? aEnd : aStart;
            spans.push({
              traceId: TRACE_ID,
              spanId: makeSpanId(`agent-${agent.id}-${wfSnapshot.runId}-prompt-${turn.timestamp}`),
              parentSpanId: promptsId,
              name: turn.role === "user" ? "↑ User" : "↓ Assistant",
              startTimeUnixNano: msToNano(t),
              endTimeUnixNano: msToNano(t),
              kind: "EVENT",
              attributes: { "pi.text": turn.text },
              resource: { "service.name": turn.role === "user" ? "user" : "assistant" },
            });
          }
        }

        if (toolCallTurns.length > 0) {
          const toolsStart = Math.min(...toolCallTurns.map((t) => t.timestamp));
          const toolsEnd = Math.max(...toolCallTurns.map((t) => t.timestamp));
          const toolsId = makeSpanId(`agent-${agent.id}-${wfSnapshot.runId}-toolcalls`);
          spans.push({
            traceId: TRACE_ID,
            spanId: toolsId,
            parentSpanId: agentSpanId,
            name: "Tool calls",
            startTimeUnixNano: msToNano(toolsStart),
            endTimeUnixNano: msToNano(toolsEnd + 1),
            resource: { "service.name": "tool" },
            kind: "INTERNAL",
          });
          for (const turn of toolCallTurns) {
            const name = turn.toolName ? `⚙ ${turn.toolName}` : "⚙ tool";
            spans.push({
              traceId: TRACE_ID,
              spanId: makeSpanId(`agent-${agent.id}-${wfSnapshot.runId}-toolcall-${turn.timestamp}`),
              parentSpanId: toolsId,
              name,
              startTimeUnixNano: msToNano(turn.timestamp),
              endTimeUnixNano: msToNano(turn.timestamp),
              kind: "EVENT",
              resource: { "service.name": "tool" },
            });
          }
        }
      }
    }
  }

  // EVENT spans are returned as ordinary children. The waterfall's
  // foldEventsIntoParent draws them as inline markers on the parent's row
  // instead of giving each one a row, and hands them back on FlatRow.events.
  return spans;
}
