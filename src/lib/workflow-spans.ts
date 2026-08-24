import type { OtelSpan } from "react-otel-trace-waterfall";
import type { SessionMessage } from "@/hooks/use-session-messages";
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
  options?: { sessionRunning?: boolean; now?: number },
): OtelSpan[] {
  const now = options?.now ?? Date.now();
  const spans: OtelSpan[] = [];

  // ── Gather all timestamps to compute trace bounds ───────────────────────
  const agentMs = snapshot.agents
    .filter((a) => a.startedAt)
    .flatMap((a) => [
      new Date(a.startedAt!).getTime(),
      a.endedAt ? new Date(a.endedAt).getTime() : now,
    ]);
  const msgMs = messages
    .filter((m) => m.text.trim().length > 0)
    .map((m) => new Date(m.createdAt).getTime());
  const hasActive = snapshot.agents.some(
    (a) => a.status === "running" || a.status === "queued",
  );
  const allMs = [...agentMs, ...msgMs, ...(hasActive ? [now] : [])];

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
  const visibleMessages = messages.filter((m) => m.text.trim().length > 0);
  if (visibleMessages.length > 0) {
    const convStart = Math.min(...msgMs);
    const convEnd = Math.max(...msgMs);
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

    // Each message is an EVENT — always visible as a fixed marker regardless of zoom.
    for (const msg of visibleMessages) {
      const t = new Date(msg.createdAt).getTime();
      const nano = msToNano(t);
      spans.push({
        traceId: TRACE_ID,
        spanId: makeSpanId(`msg-${msg.id}`),
        parentSpanId: convId,
        name: msg.role === "user"
          ? `↑ ${msg.text.trim().slice(0, 60)}`
          : `↓ ${msg.text.trim().slice(0, 60)}`,
        startTimeUnixNano: nano,
        endTimeUnixNano: nano,
        kind: "EVENT",
        attributes: { msg_id: msg.id },
        resource: { "service.name": msg.role === "user" ? "user" : "assistant" },
      });
    }
  }

  // ── Workflow branch (only for real workflow runs) ────────────────────────
  if (snapshot.runId && snapshot.agents.length > 0) {
    const wfStart = snapshot.startedAt
      ? new Date(snapshot.startedAt).getTime()
      : traceStart;
    const wfEnd = snapshot.completedAt
      ? new Date(snapshot.completedAt).getTime()
      : snapshot.runningCount > 0
        ? now
        : traceEnd;

    const wfId = makeSpanId(`wf-${snapshot.runId}`);
    spans.push({
      traceId: TRACE_ID,
      spanId: wfId,
      parentSpanId: sessionId,
      name: snapshot.name,
      startTimeUnixNano: msToNano(wfStart),
      endTimeUnixNano: msToNano(wfEnd),
      resource: { "service.name": "workflow" },
      kind: "INTERNAL",
    });

    const phases =
      snapshot.phases.length > 0 ? snapshot.phases : ["Agents"];

    for (const phase of phases) {
      const phaseAgents = snapshot.agents.filter(
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
      const phaseId = makeSpanId(`phase-${snapshot.runId}-${phase}`);

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

        spans.push({
          traceId: TRACE_ID,
          spanId: makeSpanId(`agent-${agent.id}-${snapshot.runId}`),
          parentSpanId: phaseId,
          name: agent.label,
          startTimeUnixNano: msToNano(aStart),
          endTimeUnixNano: msToNano(aEnd),
          attributes: {
            "pi.status": agent.status,
            "pi.agent_id": agent.id,
            "pi.run_id": snapshot.runId,
            ...(agent.prompt ? { "pi.user_prompt": agent.prompt.slice(0, 200) } : {}),
            ...(agent.tokens ? { "gen_ai.usage.total_tokens": agent.tokens } : {}),
            ...(agent.error ? { "error.message": agent.error } : {}),
          },
          status: agent.status === "error" ? { code: "ERROR", message: agent.error } : undefined,
          resource: { "service.name": "agent" },
          kind: "INTERNAL",
        });
      }
    }
  }

  // Move EVENT child spans into their parent's _events attribute so the parent
  // row can render them as inline markers without creating a separate row each.
  const eventsByParent = new Map<string, Array<{ t: string; name: string; service: string; msgId: string }>>();
  for (const span of spans) {
    if (span.kind === "EVENT" && span.parentSpanId) {
      const arr = eventsByParent.get(span.parentSpanId) ?? [];
      arr.push({
        t: span.startTimeUnixNano,
        name: span.name,
        service: (span.resource?.["service.name"] as string) ?? "",
        msgId: (span.attributes?.["msg_id"] as string) ?? "",
      });
      eventsByParent.set(span.parentSpanId, arr);
    }
  }

  return spans
    .filter((s) => !(s.kind === "EVENT" && s.parentSpanId))
    .map((s) => {
      const events = eventsByParent.get(s.spanId);
      if (!events) return s;
      return { ...s, attributes: { ...s.attributes, _events: JSON.stringify(events) } };
    });
}
