/**
 * semla-otel — Fork of pi-otel with cross-agent trace correlation.
 *
 * Adds W3C traceparent propagation through workflow tool calls so subagent
 * spans appear as children of the parent's pi.tool.workflow span rather than
 * separate root traces.
 *
 * How it works:
 *   Parent agent — tool_execution_start for "workflow":
 *     Reads the workflow tool span from the tracker, serializes it as
 *     PI_OTEL_TRACEPARENT env var. Child processes inherit env vars.
 *
 *   Child agent — before_agent_start:
 *     Reads PI_OTEL_TRACEPARENT, reconstructs the remote parent span context,
 *     and passes it to startInteraction() so the pi.interaction span becomes
 *     a child of the parent's pi.tool.workflow span.
 *
 * Everything else is identical to pi-otel.
 */
import { basename } from "node:path";
import { context as otelContext, trace, TraceFlags } from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { ATTR_FINISH_REASONS, ATTR_HTTP_STATUS_CODE, ATTR_PI_CWD, ATTR_PI_SESSION_ID, ATTR_REQUEST_MODEL, ATTR_RESPONSE_ID, ATTR_RESPONSE_MODEL, ATTR_SYSTEM, applyUsageAttrs, GEN_AI_SYSTEM_PI, } from "./attrs.js";
import { resolveConfig } from "./config.js";
import { emitLifecycleLog } from "./otel/logs.js";
import { initSdk, probeEndpoint, shutdownSdk } from "./otel/sdk.js";
import { SpanTracker } from "./spans.js";
const TRACER_NAME = "semla-otel";
const TRACER_VERSION = "0.1.0";
const SEVERITY_MAP = {
    debug: SeverityNumber.DEBUG,
    info: SeverityNumber.INFO,
    warn: SeverityNumber.WARN,
    error: SeverityNumber.ERROR,
};
const ENV_TRACEPARENT = "PI_OTEL_TRACEPARENT";

/**
 * Parse a W3C traceparent string and return an OTel context containing a
 * non-recording remote span with that context. Returns undefined on failure.
 */
function buildParentContext(traceparent) {
    if (!traceparent) return undefined;
    // Format: 00-{traceId:32hex}-{spanId:16hex}-{flags:2hex}
    const parts = traceparent.split("-");
    if (parts.length !== 4 || parts[0] !== "00") return undefined;
    const [, traceId, spanId, flagsHex] = parts;
    if (!traceId || traceId.length !== 32) return undefined;
    if (!spanId || spanId.length !== 16) return undefined;
    const traceFlags = parseInt(flagsHex, 16);
    if (isNaN(traceFlags)) return undefined;
    const spanCtx = {
        traceId,
        spanId,
        traceFlags: traceFlags & TraceFlags.SAMPLED ? TraceFlags.SAMPLED : TraceFlags.NONE,
        isRemote: true,
    };
    // wrapSpanContext creates a NonRecordingSpan — a lightweight handle that
    // carries the span context so new spans can reference it as their parent.
    const remoteParent = trace.wrapSpanContext(spanCtx);
    return trace.setSpan(otelContext.active(), remoteParent);
}

export default function (pi) {
    // pi-otel:log — any pi extension can emit structured log records through
    // pi-otel. No-op when signals.logs is disabled (LoggerProvider not registered).
    pi.events.on("pi-otel:log", (data) => {
        if (!data || typeof data !== "object")
            return;
        const { eventName = "pi-otel.log", severity = "info", body = "", attributes = {}, } = data;
        emitLifecycleLog(eventName, SEVERITY_MAP[severity] ?? SeverityNumber.INFO, body, attributes);
    });
    let ctx0;
    let tracker = null;
    let sessionIdRef;
    let sessionStartLogged = false;
    const notify = (msg, severity = "info") => {
        try {
            ctx0?.ui?.notify?.(msg, severity);
        }
        catch {
            // best-effort
        }
    };
    function wireSdk(cfg, opts = {}) {
        initSdk(cfg, notify, opts);
        const tracer = trace.getTracer(TRACER_NAME, TRACER_VERSION);
        tracker = new SpanTracker({
            tracer,
            captureContent: cfg.captureContent,
            cwd: cfg.cwd,
            sessionId: () => sessionIdRef,
        });
        pi.events.emit("pi-otel:status", {
            state: "ready",
            endpoint: cfg.endpoint,
        });
        // Fire once: wiring can happen at session_start OR later via dashboard-ready.
        if (!sessionStartLogged) {
            sessionStartLogged = true;
            pi.events.emit("pi-otel:log", {
                eventName: "pi.session.start",
                severity: "info",
                body: `pi session ${sessionIdRef ?? "(ephemeral)"} started`,
                attributes: {
                    [ATTR_SYSTEM]: GEN_AI_SYSTEM_PI,
                    [ATTR_PI_CWD]: cfg.cwd,
                    "service.name": cfg.serviceName,
                    ...(sessionIdRef ? { [ATTR_PI_SESSION_ID]: sessionIdRef } : {}),
                },
            });
        }
    }
    pi.on("session_start", async (_event, ctx) => {
        ctx0 = ctx;
        const cfg = resolveConfig(ctx.cwd);
        if (!cfg.enabled) {
            tracker = null;
            return;
        }
        // Best-effort session id from the session manager.
        try {
            const file = ctx.sessionManager?.getSessionFile?.();
            if (file)
                sessionIdRef = basename(file, ".jsonl");
        }
        catch {
            // ignore
        }
        // Defer SDK init until the endpoint is reachable — otherwise the metric
        // reader / log processor begin retrying against a dead endpoint and the
        // resulting errors get buffered and flushed once it comes online.
        if (await probeEndpoint(cfg.endpoint)) {
            wireSdk(cfg);
        }
        else {
            notify(`semla-otel: OTLP endpoint ${cfg.endpoint} not reachable — run /otel start to launch a dashboard, or /otel connect <endpoint> to wire elsewhere.`);
        }
    });
    const logError = (eventName, body, attrs = {}) => pi.events.emit("pi-otel:log", {
        eventName,
        severity: "error",
        body,
        attributes: attrs,
    });
    pi.on("before_agent_start", async (event, _ctx) => {
        // Cross-agent correlation: if a parent agent set PI_OTEL_TRACEPARENT via
        // a workflow tool call, use it to parent this interaction under that span.
        const parentCtx = buildParentContext(process.env[ENV_TRACEPARENT]);
        tracker?.startInteraction(event?.prompt, parentCtx);
        const tid = tracker?.activeTraceId();
        if (tid)
            pi.events.emit("pi-otel:trace-active", { traceId: tid });
    });
    pi.on("turn_start", async (event, _ctx) => {
        const idx = event?.turnIndex;
        tracker?.startTurn(typeof idx === "number" ? idx : undefined);
    });
    pi.on("turn_end", async (_event, _ctx) => {
        tracker?.endTurn();
    });
    pi.on("message_start", async (event, _ctx) => {
        const msg = event?.message;
        if (!msg)
            return;
        if (msg.role === "user") {
            tracker?.noteUserMessage(msg.content);
        }
        else if (msg.role === "toolResult") {
            tracker?.noteToolResultMessage({
                toolCallId: msg.toolCallId,
                toolName: msg.toolName,
                content: msg.content,
            });
        }
    });
    pi.on("before_provider_request", async (event, _ctx) => {
        // event.payload shape varies per provider; try to lift a model field.
        const payload = event?.payload;
        const model = payload?.model ?? payload?.modelId ?? payload?.modelName ?? undefined;
        tracker?.startLlmRequest(typeof model === "string" ? model : undefined);
        if (typeof model === "string") {
            tracker?.setLlmAttrs({ [ATTR_REQUEST_MODEL]: model });
        }
    });
    pi.on("after_provider_response", async (event, _ctx) => {
        const status = event?.status;
        const headers = event?.headers ?? {};
        const attrs = {};
        if (typeof status === "number")
            attrs[ATTR_HTTP_STATUS_CODE] = status;
        // Common response-id headers across providers.
        const respId = headers["x-request-id"] ??
            headers["request-id"] ??
            headers["anthropic-request-id"] ??
            headers["openai-response-id"];
        if (typeof respId === "string")
            attrs[ATTR_RESPONSE_ID] = respId;
        tracker?.setLlmAttrs(attrs);
        // Note: end is deferred to message_end so we can attach usage/cost.
    });
    pi.on("message_end", async (event, _ctx) => {
        const msg = event?.message;
        if (!msg || msg.role !== "assistant")
            return;
        const attrs = {};
        if (typeof msg.model === "string")
            attrs[ATTR_RESPONSE_MODEL] = msg.model;
        const finish = msg.finishReason ?? msg.stopReason ?? msg.finish_reason;
        if (typeof finish === "string")
            attrs[ATTR_FINISH_REASONS] = [finish];
        applyUsageAttrs(attrs, msg.usage);
        tracker?.setLlmAttrs(attrs);
        tracker?.noteAssistantMessage(msg);
        tracker?.endLlmRequest();
        if (finish === "error") {
            logError("pi.llm_request.error", msg.errorMessage ?? `LLM request failed (${finish})`, {
                ...(typeof msg.model === "string"
                    ? { [ATTR_RESPONSE_MODEL]: msg.model }
                    : {}),
                [ATTR_FINISH_REASONS]: finish,
            });
        }
    });
    pi.on("tool_execution_start", async (event, _ctx) => {
        const e = event;
        if (!e?.toolCallId || !e?.toolName)
            return;
        tracker?.startTool(e.toolCallId, e.toolName, e.args);
        // Cross-agent correlation: when a workflow tool fires, inject the
        // tool span's trace context into PI_OTEL_TRACEPARENT so child processes
        // inherit it and link their pi.interaction spans as children.
        if (e.toolName === "workflow" && tracker) {
            const toolCtx = tracker.getToolContext(e.toolCallId);
            if (toolCtx) {
                const spanCtx = trace.getSpanContext(toolCtx);
                if (spanCtx && spanCtx.traceFlags & TraceFlags.SAMPLED) {
                    const flagsHex = spanCtx.traceFlags.toString(16).padStart(2, "0");
                    process.env[ENV_TRACEPARENT] = `00-${spanCtx.traceId}-${spanCtx.spanId}-${flagsHex}`;
                }
            }
        }
    });
    pi.on("tool_execution_end", async (event, _ctx) => {
        const e = event;
        if (!e?.toolCallId)
            return;
        tracker?.endTool(e.toolCallId, { isError: !!e.isError, result: e.result });
        // Clean up env var once the workflow tool completes so subsequent
        // non-workflow interactions in this session don't inherit it.
        if (e.toolName === "workflow") {
            delete process.env[ENV_TRACEPARENT];
        }
        if (e.isError) {
            logError("pi.tool.error", `tool ${e.toolName} failed`, {
                "gen_ai.tool.name": e.toolName,
                "gen_ai.tool.call.id": e.toolCallId,
            });
        }
    });
    pi.on("agent_end", async (_event, _ctx) => {
        tracker?.endInteraction();
    });
    pi.on("session_shutdown", async (_event, _ctx) => {
        // Defensive: close any in-flight interaction before flushing.
        tracker?.endInteraction();
        pi.events.emit("pi-otel:log", {
            eventName: "pi.session.end",
            severity: "info",
            body: `pi session ${sessionIdRef ?? "(ephemeral)"} ended`,
            attributes: {
                [ATTR_SYSTEM]: GEN_AI_SYSTEM_PI,
                ...(sessionIdRef ? { [ATTR_PI_SESSION_ID]: sessionIdRef } : {}),
            },
        });
        await shutdownSdk();
        pi.events.emit("pi-otel:status", { state: "shutdown" });
        tracker = null;
    });
    // Anchor exported for the launcher extension. The launcher can call
    // `pi.events.emit("pi-otel:request-status", null)` and we reply with state.
    pi.events.on("pi-otel:request-status", () => {
        pi.events.emit("pi-otel:status", {
            state: tracker ? "ready" : "disabled",
        });
    });
    // Re-init the SDK when the dashboard becomes available mid-session, or when
    // `/otel connect` rewires us to an external collector.
    pi.events.on("pi-otel:dashboard-ready", async (payload) => {
        if (!ctx0)
            return;
        const cfg = resolveConfig(ctx0.cwd);
        if (!cfg.enabled)
            return;
        const override = (payload ?? {});
        if (typeof override.endpoint === "string" && override.endpoint) {
            cfg.endpoint = override.endpoint;
        }
        if (typeof override.protocol === "string" && override.protocol) {
            cfg.protocol = override.protocol;
        }
        await shutdownSdk();
        wireSdk(cfg, { silentSuccess: true });
    });
}
//# sourceMappingURL=index.js.map
