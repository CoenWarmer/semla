# Plan: making subagent context pressure visible, then escalable

**Goal:** know how often a workflow subagent runs out of context, and stop a
truncated subagent from being recorded as a successful one.

**Status:** designed 2026-09-08, not started. Phase 1 is measurement and is
worth doing on its own. Phase 3 changes behaviour and should not be designed
until phase 1 has produced numbers.

---

## 1. The question this came from

*Should a subagent sense that its context is about to overflow and spawn other
subagents, or should it just compact?*

Neither, and the reason is not a preference between the two. Compaction is
already happening, Semla did not choose it, and — this is the part that matters
— **nothing in Semla can tell that it happened.** The policy question is
downstream of a measurement gap, so the measurement comes first.

---

## 2. What is true today

### 2.1 Subagents inherit auto-compaction by default

A subagent is a full pi `AgentSession`, created at
`agent.ts:911` (`createAgentSession`). Nothing in the workflow layer passes a
compaction setting, and the session deliberately uses the real
`SettingsManager` rather than an in-memory one — the comment at `agent.ts:915`
explains why (an in-memory manager loses the user's provider/model defaults and
subagents silently fall back to an unauthenticated model).

So subagents get pi's default, which is on. Paths in this section are relative
to `node_modules/@earendil-works/pi-coding-agent/dist/`:

```
DEFAULT_COMPACTION_SETTINGS = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 }
```

— `core/compaction/compaction.js:74`.

`_checkCompaction` (defined at `core/agent-session.js:1510`) runs after every assistant turn and again before each prompt
(`core/agent-session.js:776`, `:865`), and `shouldCompact` fires when
`contextTokens > contextWindow - reserveTokens`
(`core/compaction/compaction.js:160`).

### 2.2 On real overflow, the SDK does not throw

`core/agent-session.js:1531-1560` is the interesting block. On
`isContextOverflow(...)` it attempts exactly one compact-and-retry, guarded by
`_overflowRecoveryAttempted`. If that attempt also fails it emits a
`compaction_end` event with

> "Context overflow recovery failed after one compact-and-retry attempt."

and **returns `false`**. No exception leaves the SDK.

### 2.3 Semla's workflow layer never looks

Two gaps, both in `agent.ts`:

- `throwIfProviderLimit` (`agent.ts:118`, called at `:182` and `:999`) reads the
  last assistant message's `stopReason`/`errorMessage` via `lastAssistantError`
  (`agent.ts:97`) — and then only matches quota/rate-limit text through
  `classifyProviderLimit` (`errors.ts`). A context-overflow message does not
  match, so it falls through.
- `stopReason === "length"` is checked nowhere in the extension.

What happens instead: if the truncated turn left assistant text, the
`finalAssistantText` check at `agent.ts:1015` passes and the agent is recorded
`status: "done"`. If it left none, it becomes `AGENT_EMPTY_OUTPUT`
(`agent.ts:1017`), indistinguishable from a subagent that simply said nothing.

**A subagent cut off mid-thought is, in the run record, a successful subagent.**
That is the finding. For a harness whose product is traceability it is the
defect, independent of any policy about what to do next.

### 2.4 Nothing counts it

- `PersistedAgentState` (`workflow-run-reader.ts:25`) carries `status`,
  `tokens`, `tokenUsage`, `error` — no stop reason, no compaction count, no
  retry count.
- `WORKFLOW_AGENT_SPAN`'s end attributes (`schema.ts:223`) are `status`
  (`"done" | "error" | "aborted"`), `turns`, `total_tokens`, `cost`.
- `onAgentEnd`'s event shape (`workflow.ts:288`) has no field to carry one, and
  `WorkflowManager` derives status from `event.result === null` alone
  (`workflow-manager.ts:938`).
- pi emits `compaction_start` / `compaction_end` on the session event stream
  (`core/agent-session.d.ts:53`, `:65`), carrying `reason`, `willRetry`,
  `errorMessage` and a `CompactionResult` with `tokensBefore` /
  `estimatedTokensAfter`. Semla subscribes to that stream already — for history
  only (`agent.ts:982`) — and drops every event that is not a message.

### 2.5 One thing the research could not establish

Whether auto-compaction actually fires for subagents in practice. The settings
inheritance says it must; there is no trace or log to confirm it, because the
telemetry is not wired. **Phase 1 is what turns that inference into an
observation, which is the main reason it goes first.**

---

## 3. Why not self-spawning

The original question's second option — a subagent detecting pressure and
spawning helpers — is rejected on structural grounds, not on cost.

- **The budget it would spend is not visible to it.** `shared.tokenUsage`
  (`workflow.ts:822`) is a run-wide aggregate and `budget.remaining()`
  (`workflow.ts:572`) is exposed to the *workflow author*, not to an agent's
  prompt. A spawning subagent would draw down a ceiling it cannot read.
- **`maxAgents` stops being a plan.** It is a run-level ceiling; making fan-out
  data-dependent means the same task costs a different amount each run.
- **It inverts the decomposition authority.** The orchestrator handed out a
  scoped task and would get back a task tree it never approved.
- **Overflow is the wrong trigger for decomposition.** Exhaustion says the task
  was mis-sized; it does not say that *this* point is where the work splits.
  Cutting where the token counter landed is arbitrary.

`agent()` already denies recursive-orchestration tools to subagents
(`subagentExcludedTools`, `agent.ts:941`, issue #107). This plan does not
reopen that.

---

## 4. Phase 1 — make it visible

No behaviour change. Every step is threading a value that already exists to a
place that already exists.

### 4.1 Capture the SDK's own signals

`agent.ts` already calls `session.subscribe(...)` for history. Extend that
subscription to record, per agent call:

- `compaction_start` / `compaction_end` — count, `reason`
  (`manual | threshold | overflow`), `willRetry`, and `tokensBefore` /
  `estimatedTokensAfter` from `CompactionResult`.
- the last assistant `stopReason`, which `lastAssistantError` (`agent.ts:97`)
  already reads and currently discards unless it matches a provider limit.

Keep this strictly diagnostic in phase 1: it must not change what `agent()`
returns or throws. The `finally` block at `agent.ts:1027` already treats history
as "diagnostic only; never let it mask the real result" (`agent.ts:1033`) — same
contract.

### 4.2 Thread it through the seams

| Seam | Change |
|---|---|
| `onAgentEnd` event (`workflow.ts:288`) | Add optional `stopReason`, `compactions`, `compactionReasons` |
| `WorkflowManager.onAgentEnd` (`workflow-manager.ts:936`) | Copy onto the snapshot entry; keep `status` derivation unchanged |
| `WorkflowAgentSnapshot` (`src/types/workflow.ts:17`) | Same optional fields |
| `PersistedAgentState` (`workflow-run-reader.ts:25`) | Same, so the run JSON retains it |
| `agentEnded` (`telemetry/workflow-recorder.ts:41`) | Accept and set the new attributes |
| `WORKFLOW_AGENT_SPAN` end attributes (`telemetry/schema.ts:223`) | `semla.workflow.agent.stop_reason` (low cardinality), `semla.workflow.agent.compactions` (number) |

`status` stays `"done" | "error" | "aborted"`. Adding a fourth value would
change how existing panels render and is not needed to count anything.

### 4.3 The `telemetryContext` question

pi's own telemetry defines a compaction span and a `stop_reason` attribute, but
Semla never passes `telemetryContext` into a subagent session (`grep -rn
"telemetryContext" src` → no matches). Wiring it would get some of §4.1 for
free.

**Do §4.1 first anyway.** The event subscription is local to `agent.ts` and
independently testable; passing a telemetry context into every subagent session
changes what the span tree looks like for every existing run and is a larger
blast radius. Treat it as a follow-up, and decide it with §4.1's data in hand.

### 4.4 Verification

This phase is verifiable without trusting a report, which is the point:

- A run's JSON at
  `~/.pi/workflows/projects/<project>/runs/<runId>.json` either carries
  `stopReason` / `compactions` per agent afterwards, or it does not.
- A unit test with a session double that emits `compaction_end` asserts the
  fields reach `onAgentEnd`.
- A recorded-span test (`src/lib/recorded-spans.test.ts` is the existing
  pattern) asserts the two new span attributes.
- One real workflow with a deliberately oversized research prompt should show a
  non-zero compaction count — which is also what settles §2.5.

---

## 5. Phase 2 — decide with the numbers

Once §4 lands, a run answers "N of M agents compacted, and K hit the ceiling".

That number distinguishes the two explanations, which currently cannot be told
apart:

- **Mostly research agents compacting** → a task-sizing problem. The fix is the
  two-phase pattern AGENTS.md already prescribes (research returns a summary;
  implementation works from the summary), not a new mechanism.
- **Compaction spread across agent kinds, or overflow recovery failing** → a
  real ceiling problem, and phase 3 is justified.

A per-run counter joins existing per-run aggregates naturally —
`session-agent-counts.ts` already derives counts across a session's runs from
snapshots, and `WorkflowSnapshot` already carries `doneCount` / `errorCount` /
`runningCount`.

**Do not skip to phase 3.** Building an escalation path before knowing the rate
risks paying for a mechanism whose real fix was prompt shape.

---

## 6. Phase 3 — escalation with a partial result (conditional)

Only if phase 2 says the ceiling is real.

The precedent to copy is `loopUntilDry` (`workflow.ts:1318`), which already
returns a partial result instead of aborting when it catches
`TOKEN_BUDGET_EXHAUSTED` or `AGENT_LIMIT_EXCEEDED` (`workflow.ts:1336-1344`). A
plain `agent()` call has no equivalent — it throws, and there is no partial-result
channel outside that helper.

Shape:

- A new `WorkflowErrorCode.AGENT_CONTEXT_EXHAUSTED` (`errors.ts:31`), thrown
  when the captured `stopReason` and failed overflow recovery say so.
  `recoverable` should probably be `false` — retrying walks into the same wall,
  which is the reasoning `PROVIDER_USAGE_LIMIT` already documents at
  `errors.ts:45`.
- The subagent returns what it established, with citations, plus what it did not
  reach. The orchestrator decides whether to re-decompose, widen the budget, or
  accept the partial. Decomposition authority stays in one place.
- Detection belongs next to `throwIfProviderLimit` (`agent.ts:118`), which is
  already the one place terminal assistant metadata is read.

**Open design question, deliberately not answered here:** whether a partial
result is a resolved value with a completeness flag, or a thrown error the
orchestrator catches. `loopUntilDry` does the latter internally; a value is
easier for a workflow author to handle. Decide with a real failing run in hand.

---

## 7. Where compaction is genuinely right

One case, and it should stay an explicit opt-in rather than a default: a long,
irreducibly serial task where early context is provably dead — a build-fix loop
where only the current error matters. Dropping history there is not lossy in any
way that affects the result.

That is narrow. It is an argument for a per-`agent()` compaction setting, not
for the current situation where every subagent gets compaction by inheritance
and nobody is told.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| Phase 1 mistaken for a fix | It is not: it counts the problem, it does not change behaviour |
| Diagnostic capture masking a real result | Same contract as history: caught and ignored in `finally` (`agent.ts:1027`) |
| Adding a `status` value breaks existing panels | Don't. New optional fields only; `status` stays three-valued |
| `telemetryContext` changes every run's span tree | Deferred to §4.3, decided after §4.1 |
| §2.5's inference is wrong and subagents never compact | Then phase 1 reports zero, which is itself the answer, cheaply |
| Phase 3 built for a rate that turns out negligible | Gated behind phase 2 |

---

## 9. Deferred

- Self-spawning subagents. §3.
- Exposing remaining context to a subagent's prompt. It invites the agent to
  reason about its own budget, which is the same authority inversion as §3 in a
  softer form.
- Per-`agent()` compaction settings. §7 makes the case; wait until phase 1 shows
  where compaction actually happens.
- Reserving context per agent kind (research vs implementation). Depends on
  phase 2's breakdown.
