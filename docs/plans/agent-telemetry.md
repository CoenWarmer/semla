# Plan: real spans for the agent and its subagents

**Goal:** instrument the host agent's turns and every subagent a workflow
spawns, as real spans with a real parent/child tree — and render them in the
trace panel that already exists, instead of the ones it currently invents.

**Status:** designed, not started. Written 2026-09-02. Layers 1 and 2 of the
three sketched in discussion are in scope; a collector is not (§9). Six open
questions are in §8 and none of them block starting on §6 step 1.

---

## 1. What is actually true today

**The trace panel does not display telemetry. It manufactures it.**

`session-workflow-panel.tsx:1005` hands `TraceWaterfall` the result of
`workflowSnapshotToSpans(snapshot, messages, …)` — `src/lib/workflow-spans.ts:34`.
Every input is app state already on the client: a `WorkflowSnapshot` from the
workflow manager, the transcript from `useSessionMessages`, and `Date.now()`.
The module says so itself:

> These spans are synthesised from app state rather than ingested from a real
> trace, so they use the library's millisecond timing form and its
> deterministic id helpers.

There is one fixed trace id per page load (`makeTraceId("semla-session")`) and
no exporter, endpoint, `traceparent` or collector anywhere in `src`. So the
panel is a drawing of what the UI happens to know, not a record of what ran.

What that costs is precision. Agent timings come from snapshot fields the
manager writes when an agent *completes*; tool spans come from persisted entries
or the live SSE markers. Anything the UI never learned — a provider retry, time
spent inside compaction, a subagent's own tool calls — is simply not in the
picture. This session's `extensions-bound: 33,115ms` finding is the shape of the
problem: the thing that dominated a turn was invisible until something measured
it directly.

**semla-otel was not connected to any of this.** It was a fork of `pi-otel`, an
extension exporting over OTLP, loaded only through `.pi/settings.json` and
consumed by nothing. Removed in `9661bf5`; recoverable from `9661bf5~1` if the
`traceparent` propagation in it turns out to be worth reading.

## 2. What pi already provides, which changes the shape of this

`@earendil-works/pi-telemetry` (zero dependencies) defines the interface:
`TelemetryContext.startSpan`, and on a span `addEvent`, `setAttributes`,
`setStatus`. `@earendil-works/pi-agent-core` builds a **typed schema** on it and
exports the vocabulary:

```
pi.harness.run   pi.harness.turn    pi.harness.step     pi.harness.tool
pi.harness.hook  pi.harness.sleep   pi.harness.checkpoint
pi.harness.compaction   pi.harness.navigation   pi.harness.event_handler
pi.session.write        pi.ai.request
```

with `startHarnessSpan` / `startAiSpan`, per-attribute metadata carrying
`sensitive` and `cardinality` hints, `NOOP_TELEMETRY_CONTEXT`, and a working
`InMemoryTelemetryContext`. All of it importable from Semla today.

**So the schema is not ours to invent.** Defining a parallel vocabulary would be
the same mistake as forking `pi-otel`: a second description of the same events,
drifting from the one the runtime uses.

## 3. The seam, and why layer 2 splits in two

`AgentHarness` accepts a telemetry context —
`pi-agent-core/dist/harness/agent-harness.d.ts:338`, `context?: TelemetryContext`.

`createAgentSession`, which is what Semla calls, **does not forward one**. Its
options are `cwd, agentDir, modelRuntime, model, thinkingLevel, scopedModels,
noTools, tools, excludeTools, customTools, resourceLoader, sessionManager,
settingsManager, sessionStartEvent, session, extensionsResult,
modelFallbackMessage`. Neither do the lower-level factories
(`createAgentSessionServices`, `createAgentSessionFromServices`,
`AgentSessionRuntime`). The seam is one layer below what the SDK exposes.

That splits layer 2:

- **2a — derive spans from events Semla already receives.** `session.subscribe`
  delivers `turn_start`, `turn_end`, `agent_start`, `agent_end`,
  `tool_execution_start/update/end`, `message_start/update/end`
  (`pi-agent-core/dist/types.d.ts:375-382`). `session-event-router.ts` already
  handles four of those. Turn and tool spans need **no patch at all**.
- **2b — patch `createAgentSession` to forward a `telemetryContext`.** One field.
  Buys `pi.ai.request`: provider timing, token counts, retries — the layer that
  events cannot see, and precisely where this session's unexplained 72 seconds
  turned out to live. `patches/` exists now, is re-applied on install, and fails
  loudly if upstream moves, so a local patch here is a known quantity rather
  than a liability. Better still, offer it upstream: a passthrough is hard to
  argue with.

**Recommendation: do 2a first and ship it.** It is free and covers the common
case. Treat 2b as a separate, small change once 2a proves the pipeline.

## 4. Subagents need nothing from pi

`WorkflowAgent` (`dynamic-workflows/src/agent.ts:582`) calls `createAgentSession`
itself and prompts at `agent.ts:165`. That code is **vendored in this
repository**, so the same passthrough limitation applies but the call site is
ours: we can wrap the call in a span and subscribe to the subagent's own events
exactly as the host router does.

The hierarchy already exists as hooks in `workflow.ts` — `onPhase:278`,
`onAgentStart:281`, `onAgentEnd:288`, plus `onAgentJournal`
(`workflow-manager.ts:777`). Those are the points where the manager already
updates the snapshot the panel draws. Spans go in the same places.

## 5. The span tree

```
pi.harness.run            (a prompt turn; host session)
├─ pi.harness.turn        (each model round trip)
│  ├─ pi.ai.request       (2b only)
│  └─ pi.harness.tool     (one per tool call)
└─ semla.workflow.run     (a workflow the turn started)
   ├─ semla.workflow.phase
   │  └─ semla.workflow.agent      (one subagent)
   │     ├─ pi.harness.turn
   │     └─ pi.harness.tool
   └─ semla.workflow.phase …
```

`pi.*` names come from pi's schema and keep its attributes. The three
`semla.workflow.*` names are ours because the concept is ours — pi has no notion
of a phase. They are declared with `defineTelemetrySchema` so they are typed
the same way, rather than as loose strings.

A background workflow outlives the turn that started it, so its run span is a
**link**, not a child, once the prompt turn ends. Otherwise the turn span would
stay open for the duration of a background run and every trace would look like
one enormous turn.

## 6. Work, in order

1. **A span sink and a session-scoped trace id.** `src/lib/pi/telemetry/` — a
   `TelemetryContext` implementation that records spans into an array with
   parent ids, plus the schema declaration for the three `semla.workflow.*`
   spans. Pure, no I/O, unit-testable. Trace id derived from the session id so a
   reload keeps the same trace.
2. **Layer 1: workflow and subagent spans.** Emit at the existing hooks in
   `workflow.ts` / `workflow-manager.ts`, and around `createAgentSession` in
   `agent.ts`. Nothing else changes; the manager keeps writing snapshots.
3. **Transport.** A new `PiSessionEvent` variant carrying spans, published
   through the SSE stream the turn already opens — the same route
   `workflow-snapshot` takes. The panel accumulates them client-side.
4. **Render.** Feed real spans to `TraceWaterfall` and retire the synthesised
   ones for runs that have them, keeping `workflowSnapshotToSpans` as the
   fallback for runs recorded before this existed (§8.5).
5. **Persistence.** Spans alongside the run file, so a reload of a finished run
   still draws the real trace rather than falling back (§8.2).
6. **Layer 2a: host turn and tool spans** from the router's existing event
   handling.
7. **Layer 2b, optional:** the `telemetryContext` passthrough patch, for
   `pi.ai.request`.

Steps 1–4 are the useful unit; 5 makes it survive a reload; 6 extends it to the
host; 7 is the upgrade.

## 7. Decisions, with the reasoning

**Use pi's schema, do not define a parallel one.** It already names the events,
types their attributes, and marks which are sensitive. A second vocabulary would
drift, and drift is what made `workflow-spans.ts` a drawing rather than a record.

**In-app first, no collector.** `InMemoryTelemetryContext` plus the existing SSE
channel and the existing panel gets real traces on screen with nothing to
operate. OTLP export can be added later *from the same captured spans* — the
sink is an interface, so an exporter is one more implementation, not a rewrite.
This also fits the stated goal: a run should be inspectable, and inspectable
means in the tool.

**Spans are recorded, not just streamed.** A turn that fails is the one worth
looking at, and a stream that dropped is exactly when you cannot see it.

**No patch in the first cut.** 2a covers turns and tools with events Semla
already receives. Patching for `pi.ai.request` is worth doing, but as its own
change with its own justification, not smuggled into the foundation.

## 8. Open questions

1. **Always on, or opt-in?** Recommendation: always on for the in-app sink,
   bounded (§8.3). It is cheap, and telemetry you have to remember to enable is
   telemetry you do not have when it matters.
2. **Persist where?** Options: beside the run file under
   `~/.pi/workflows/projects/<key>/runs/`; a `session_spans` table; or
   `.semla-debug`. Recommendation: the run file's directory, disk-first like
   everything else, with Postgres left out until something needs it off-machine.
3. **What bound?** A long orient run emits thousands of spans. A cap per trace
   with an explicit "truncated" marker, the way `code_map` states its own
   limits, rather than silent loss.
4. **Sensitive attributes.** pi marks some attributes `sensitive`. Recommendation:
   drop them at the sink by default, with a dev-only switch — prompts and tool
   arguments are already in `.semla-debug` if wanted, and this is the one
   decision that is hard to walk back once traces are persisted.
5. **Do synthesised spans stay?** They are the only thing that can draw a run
   recorded before this lands. Recommendation: keep as a labelled fallback,
   never merged with real spans in one trace.
6. **Offer 2b upstream, or patch locally?** Recommendation: both — patch to
   unblock, and offer the passthrough, because carrying it forever is worse than
   a week of waiting.

## 9. Deliberately not in scope

- **A collector, and OTLP export.** Layer 3 in the discussion. The sink is an
  interface so this stays open, but nothing here requires standing one up.
- **`traceparent` propagation across processes.** What semla-otel's fork was
  for. Subagents run in-process here, so the parent id is a variable, not a
  header. It matters if subagents ever become separate processes.
- **Instrumenting the extension load path.** `debug-writer.ts` phase markers
  already cover it (`extensions-compiled`, `extensions-bound`), and they are the
  reason that cost was found at all. Folding them into spans is tidier and can
  wait.
