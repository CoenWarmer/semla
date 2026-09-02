# Plan: real spans for the agent and its subagents

**Goal:** instrument the host agent's turns and every subagent a workflow
spawns, as real spans with a real parent/child tree — and render them in the
trace panel that already exists, instead of the ones it currently invents.

**Status:** designed, not started. Written 2026-09-02. Layers 1 and 2 of the
three sketched in discussion are in scope; a collector is not (§9). The four
decisions that shape the storage and the span tree are settled in §8; two
smaller ones are noted there as still open and neither blocks §6 step 1.

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

A background workflow outlives the turn that started it and still nests under
it — decided in §8.4, which also covers what that means for closing the turn
span from the continuation rather than from `runPiPrompt`.

## 6. Work, in order

1. **A span sink and a session-scoped trace id.** `src/lib/pi/telemetry/` — a
   `TelemetryContext` implementation that records spans into an array with
   parent ids, plus the schema declaration for the three `semla.workflow.*`
   spans. Pure, no I/O, unit-testable. Trace id derived from the session id so a
   reload keeps the same trace. Takes `sensitive` and `maxSpans` options from
   the outset (§8.1, §8.3) and counts recorded spans always.
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

## 8. Decided, 2026-09-02

Four were put to Coen and answered. Three went against the recommendation
above; the reasoning that follows is his choice plus what it costs to build,
not a re-argument.

**8.1 Sensitive attributes: keep them, for now.** pi flags some attributes
`sensitive` — prompts and tool arguments among them — and they are recorded.
Said plainly so a later reader is not surprised: persisted traces under
`~/.pi/workflows/projects/<key>/runs/` will contain prompt and tool-argument
text, unencrypted, for as long as the run files live, and anything that later
ships those spans anywhere inherits that.

"For now" is load-bearing, so **the redaction is built and defaulted off**
rather than left out. A `sensitive: "keep" | "drop"` option on the sink, honoured
at record time, is a few lines while the sink is being written and a plumbing
job afterwards. Flipping it later must not mean revisiting every call site.

**8.2 Persisted beside the run file.** `~/.pi/workflows/projects/<key>/runs/`,
alongside the state the reader already knows how to find. Disk-first like every
other record here, and no migration. Not visible off-machine, which is accepted.

**8.3 No cap.** Everything is recorded. Same accommodation as 8.1: the sink
takes a `maxSpans` that defaults to `Infinity`, and **counts what it records
regardless**, so if a run ever produces a file that hurts, the number is already
in the trace rather than something to go and measure. A cap becomes a config
change, not a redesign.

**8.4 A background workflow nests under its turn.** One trace tells the whole
causal story, at the cost of a backgrounded turn reading as minutes long.

This is more consistent with the rest of Semla than the alternative was.
`is_running` already stays true through a background continuation
(`decideContinuation` returns `watch`, and the flag is cleared by
`background-continuation.ts`, not by the turn), so a turn that spawns a workflow
*already* reads as ongoing everywhere else in the UI. A 6-minute turn span
agrees with the 6-minute spinner. The recommendation would have made the trace
the one place that disagreed.

It does move a span's lifetime across a module boundary: the turn span cannot be
closed by `runPiPrompt`'s `finally`, because the run it parents outlives it. The
continuation closes it — which is tractable only because that code is now its
own module with an explicit hand-off (`a5e0b85`). Concretely: the sink is keyed
by session, the turn span id is handed to `runBackgroundContinuation` the way
`agentCwd` and `debug` already are, and the `settled` / `watch` / `idle` branches
decide whether the turn span closes now or later. A dropped stream must still
close it, or a trace stays open forever — the same `finally` that clears
`is_running` is the right place.

**Still open, neither blocking:** whether synthesised spans stay as a labelled
fallback for runs recorded before this (recommendation: yes, never merged into
one trace with real spans), and whether 2b is patched locally, offered upstream,
or both (recommendation: both).

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
