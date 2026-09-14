# Design: a background workflow must report itself even after Semla's watchdog is gone

**Status:** design only. No production code in this document; the two snippets
below illustrate a shape, not an implementation.

**Goal, restated precisely:** a workflow started in the background, whose
run genuinely takes longer than `TIMEOUT_MS` (30 minutes) to reach a terminal
status, must still cause its result to appear in the conversation the user
sees — without the user having to send a new prompt to trigger recovery.

Everything below assumes the SETTLED FACTS and the four investigation reports
in the task exactly as given. Nothing here re-derives them.

---

## 1. The mechanism, end to end

### 1.0 What "noticed" has to mean here

There is no process, upstream or in Semla, that is *notified* when a run file
transitions to terminal on disk. `run-persistence.ts` has no watch/emit
surface (confirmed by grep — no `chokidar`, no `fs.watch`, no callback API).
The only two ways anything finds out a run is done are: (1) something is
subscribed to the live `WorkflowManager`'s in-memory `"complete"` event while
the run is executing in that same process, or (2) something reads the run
file off disk and checks `status`. Once `runBackgroundContinuation`'s
`setInterval` watchdog is gone (past `TIMEOUT_MS`, or the whole
request/session was torn down some other way), option (1) is unreachable for
that run — the closure is gone, not merely dormant. So "noticed" necessarily
means (2): something, running independently of any specific session, has to
poll disk.

That reframes the four options the task lists: (a)/(b) are both really "make
sure disk gets polled after the per-request watchdog can no longer do it";
(c) is "reattach *execution*, not just noticing, to a persisted run"; (d) is
"skip noticing-during-the-conversation entirely and let the next transcript
read show it."

### 1.a Re-arm / never stop the per-request watchdog

Keep `runBackgroundContinuation`'s `setInterval` running past `TIMEOUT_MS`
instead of giving up.

Does not satisfy the goal. The watchdog's `setInterval` lives inside one
`runPiPrompt` call's closure, which lives inside one Next.js request. Even if
`timeoutMs` were raised to infinity, the request handler itself does not run
forever in a serverless-shaped Next.js deployment, and even in Semla's
single-persistent-instance model (per `background-sessions.ts`'s own
docblock) an unbounded `setInterval` per background run is an indefinitely
growing set of live timers and retained `AgentSession`/bash-executor objects
for every background run ever started — which is exactly the leak §4 asks
about, made permanent rather than bounded. It also does not fix the actual
failure: `TIMEOUT_MS` was chosen as a ceiling on purpose (467dee7 changed what
happens when it fires, not whether it should exist). "Never time out" is not
a design, it is deleting the ceiling. Rejected.

### 1.b A process-level sweeper that watches run files on disk and delivers on transition to terminal

A background task — started once, from `instrumentation.ts`'s `register()`,
alongside the model-catalog refresh and language-server setup that already
run there — polls `run-persistence.ts`'s run directories (or, cheaper,
Semla's own per-session `workflow-run-index.ts`, which already lists exactly
the runs with `status === "running"` per session) on an interval measured in
tens of seconds, independent of any specific request or session. When a
run's on-disk status transitions into `TERMINAL_RUN_STATUSES`, the sweeper
does the delivery itself.

Does this satisfy "reports back without me requesting"? For the *transcript*:
yes — the sweeper can append the result without any user action, at any
point, whether or not a page is open. For a *new turn*: only if the sweeper
also has (or can construct) a live `AgentSession` to call
`sendCustomMessage(..., { triggerTurn: true })` on, which is exactly the
missing capability `background-sessions.ts`'s metadata gap describes (see
§2) — the sweeper knows a `runId` and (via the index) a `semlaSessionId`, but
has no live session object for it unless one happens to still be retained.
This is the option that generalizes past `TIMEOUT_MS` correctly, because it
does not depend on any single request having stayed alive — it is the thing
that notices, independent of whichever request happened to start the run.

### 1.c Lean on upstream's `pending` queue + `resume()` to reattach a persisted run to a session

Rejected outright, and the upstream report already shows why without any
further probing needed: `WorkflowManager.resume(runId, …)` returns `false`
for a run whose persisted status is `"completed"` or `"aborted"`
(`workflow-manager.ts:1391-1397`). A run that finished during the 30-minute
window this design exists to cover is, definitionally, in exactly that state
by the time anything gets around to calling `resume()`. `resume()` is for
continuing a *paused/failed* run, not for re-announcing a *finished* one —
using it here would mean either lying about the run's status to force a
resume (corrupting the very state `fetchStuckBackgroundRuns` depends on,
which is the mistake 467dee7 just fixed in the other direction) or never
calling it for the case that actually matters. The `pending` queue
(`task-panel.ts`'s `DeliveryHolder.pending`) is real and does something
useful, but it is scoped to *upstream's own* delivery path — it holds a
message that `pi.sendMessage` failed to send from inside the same manager
instance, to flush once `resumeResultDelivery` is next called on that same
manager. Semla does not call `installResultDelivery`/`resumeResultDelivery`
the way the TUI does (`workflow.ts` wires the manager, but Semla's delivery
path today is `session.sendCustomMessage` in `background-continuation.ts`
and `session-service.ts`'s stuck-run recovery, not `pi.sendMessage`). Riding
this queue would mean adopting upstream's whole delivery lifecycle
(`suspendResultDelivery`/`resumeResultDelivery` at session start/shutdown) as
the *primary* mechanism, is bound to the same-process manager-identity
question (unknown (b), now settled by source only for the 30-second
handoff-TTL case — irrelevant here since a background run outliving
`TIMEOUT_MS` is not a same-generation reload), and its own upstream `pending`
cap is a soft 32-entry warning, not a delivery guarantee. Not recommended.

### 1.d Deliver into the session's persisted entries with no live session at all

Write the result directly into whatever the *next page load* reads —
`pi_session_entries` in Postgres and/or the session's `.jsonl` file — without
constructing a live `AgentSession`.

This is honest about what it actually gives: the result is *there* next time
anyone opens the session, with zero live-session machinery required, and
zero risk of a stale `pi.sendMessage`/`sendCustomMessage` call landing on a
disposed session (§1 of the upstream report's finding that
`sendCustomMessage` on a disposed `AgentSession` proceeds into
`_runAgentPrompt` against a disposed agent — a real hazard, not
hypothetical). But it is explicitly **not** "a new turn produced unprompted"
— per the investigation's own §6 finding, there is no raw-append primitive in
this codebase; every content-injection path found
(`session.sendCustomMessage`) requires a live `AgentSession`/`SessionManager`
to call it on, because it also has to update pi's in-memory transcript tree
(parent/child linkage) consistently with whatever `SessionManager` already
holds — writing a raw line to the `.jsonl` file or a raw row to
`pi_session_entries` outside of that object risks producing an entry with a
`parentId` that no longer matches the tree by the time pi next opens the
file, which is the same class of hazard `superseded-turns.md` documents for
a *different* race. Building that primitive is itself new, load-bearing
code this design would have to get exactly right, and it still leaves the
"unprompted new turn" half of the goal unmet — the user has to *return to
the page* (or the app has to push it live) to see anything, and even then no
new assistant turn discusses it: it is a message sitting in history, not a
report. Also does not, by itself, need a live `AgentSession`, which is worth
weighing against the leak (§4).

### Recommendation: (b), and only (b) — with (d)'s persisted-entries write as (b)'s actual delivery mechanism

**The sweeper is the *trigger*.** The *delivery* it performs, once triggered,
still has to answer "how does the message actually reach the transcript and,
where possible, the open page" — and there the honest answer is a
combination: write the message durably first (the (d) mechanism, made safe —
see §2), then, only if a live session/stream for that `semlaSessionId`
happens to still be around, also push it onto the open SSE stream and start
a report turn the way `background-continuation.ts` already does. If nothing
live exists, the durable write alone satisfies "reports back without me
requesting" in the only sense that generalizes past the process's own
lifetime: the user does not have to *ask* — they have to *look* (open or
reopen the session), same as any other message that arrived while they were
away. A literally unprompted new *turn* pushed to a closed browser tab is not
achievable without either a push channel Semla does not have (the SSE stream
is gone once `closeSessionStream` ran) or riding upstream's
`pi.sendMessage`/reload-handoff machinery, which §1.c already rules out for
this exact scenario. Recommend being honest about that ceiling rather than
architecting elaborate machinery to reach a guarantee upstream itself cannot
give across a real process boundary.

This also directly answers the task's per-option question of whether a *new
turn* results: **only opportunistically**, when a live session for that
`semlaSessionId` is still around (rare, past 30 minutes, but not impossible —
another prompt in the same session could have kept it alive). Otherwise: a
message appended, visible on next load, no new turn — because there is no
live agent to produce one.

---

## 2. What must change, file by file

**`background-sessions.ts`** — currently `Map<string, { dispose(): void }>`
with no getter and no metadata. Two things are needed from it:

- A getter (`getRetainedSession(runId)`) so a would-be deliverer can check
  "is there actually a live session I could push a new turn through" before
  falling back to the durable-write-only path. Today nothing can ask this;
  the map is write/delete-only.
- Metadata alongside each retained session: at minimum `semlaSessionId` and
  `agentCwd` (`session-event-router.ts`'s `retainBackgroundSession` calls
  already have both in scope — they are just discarded at the call site).
  The sweeper needs `agentCwd` to find the run file at all
  (`workflow-run-reader.ts`'s own docblock: the project-key hash is a guess,
  keyed by the extension's cwd, and misses silently on a mismatch) and needs
  `semlaSessionId` to know which session's index/transcript to write into.
  Without this, a sweeper that finds a terminal run on disk has a `runId`
  and nothing else to act on unless it also has independent access to
  `workflow-run-index.ts`'s per-session index files — which it does (see
  next item) — making the retained-session metadata *optional* for
  delivery-to-disk, and *required* only for the opportunistic live-turn case.

**`workflow-run-index.ts`** — already exactly the right shape for
"enumerate every run this application knows about, with its session and
status", via `listWorkflowRuns`/`listRunningWorkflowRuns`. What is missing is
a way to enumerate across *all* sessions, not just one — today every read is
keyed by `sessionId`. The sweeper needs a `listAllRunningWorkflowRuns()` (or
equivalent directory scan of `runsDir(dir)`) that returns `{ sessionId,
runId }` pairs for every session with anything still `"running"`, so it does
not need a separate catalog of "which sessions exist" to know what to check.

**A new module, e.g. `background-run-sweeper.ts`** — the actual sweeper.
Owns a single `setInterval` (started once, from `instrumentation.ts`, not
per-request), on an interval much coarser than the per-turn watchdog's 5s
(something like 60s is plenty — this is a safety net for runs that have
*already* missed a far tighter per-request watchdog, not a latency-sensitive
path). Each tick: enumerate running runs via the new index function; for each,
`readWorkflowRun(agentCwd, runId)` — needs the session's `agentCwd`, which
the index does not currently carry (see below) — check `isRunTerminal`; on a
transition, deliver (§2's durable-write primitive) and call
`finalizeBackgroundRun(semlaSessionId, runId, status)` exactly as
`background-continuation.ts`'s existing terminal branch does, so the two
paths converge on the same finalization call rather than each growing their
own.

This surfaces a second, real gap: **`workflow-run-index.ts`'s
`WorkflowRunRecord` has no `agentCwd`.** `readWorkflowRun` needs the cwd the
run's extension actually ran under to find the file (its own docblock: a
mismatch is a silent miss, and it now searches every project directory as a
fallback — cheap, but only a fallback). The index is written from
`session-event-router.ts`/`session-persistence.ts` call sites that *do* have
`agentCwd` in scope at write time. This needs adding to `WorkflowRunRecord`
(a genuine schema change, small) so the sweeper does not have to guess or
pay the full-directory-scan cost on every tick for every run.

**A new durable-delivery primitive** — the safe version of option (d).
Rather than writing directly to `.jsonl`/`pg_session_entries` bypassing
`SessionManager` (the hazard flagged in §1.d), the safer shape is: construct
a *disposable* `AgentSession` for that `semlaSessionId` purely to call
`sendCustomMessage(..., { triggerTurn: false })` on it and then dispose it —
i.e. exactly the machinery `session-service.ts` already runs at the top of
every `runPiPrompt` (`createSessionFile` → `SessionManager.open` →
`createAgentSession` → `bindExtensions`), reused for a one-message append
with no prompt. This is heavier than a raw file write, but it is the only
path in this codebase proven to keep the transcript tree internally
consistent (parent/child linkage, header versioning) — reusing it rather
than inventing a raw-append format is deliberately the smaller-risk choice
even though it costs more to build than "just append a line." Concretely:
a `deliverToRestingSession(semlaSessionId, runId, agentCwd)` function that
does this construct→send→dispose sequence, callable both by the sweeper and,
if desired, unifying `session-service.ts`'s existing stuck-run recovery
(§3) onto the same code path instead of duplicating the
`finishedRunMessage`/`sendCustomMessage` pairing a third time.

**`session-service.ts`'s stuck-run recovery** (`fetchStuckBackgroundRuns` /
the `for (const { run_id } of stuckRuns)` block) — should call whatever the
sweeper's delivery helper became, rather than keep its own inline
`session.sendCustomMessage` call, so there is one delivery implementation,
not two that can drift (one already only accepts `status === "completed"`,
silently skipping `"failed"`/`"aborted"` — worth fixing in the same pass
since the helper naturally takes a status, but flagged rather than assumed:
see open questions).

**`instrumentation.ts`** — add the sweeper's start-up call alongside the
existing model-catalog refresh etc. Needs its own explicit note here because
`instrumentation.ts`'s existing comment about `NEXT_RUNTIME !== "nodejs"`
matters doubly for a `setInterval`: it must only ever start once per process,
which `register()`'s existing single-call contract already gives for free —
but a defensive guard (a module-level boolean, mirroring how other
singletons in this codebase avoid double-init) is worth having given
Next.js's own history of calling `register()` more than once in some
dev-mode hot-reload paths — call this out as a thing to verify empirically,
not assume.

**`background-continuation.ts`** — see §3; the existing self-delivery
watchdog and terminal handling do not need to change in shape, only in what
happens when `timeoutMs` is hit.

---

## 3. How this interacts with 467dee7

467dee7's fix and this design are not solving the same problem and should sit
**alongside**, not replace, each other.

467dee7 made the timeout branch inside one *specific* `runPiPrompt` call's
continuation refuse to corrupt run status when its own watchdog gives up
early relative to the run actually finishing. That is a **correctness** fix
about not writing "completed" over a live run — it has nothing to do with
whether anything ever gets around to delivering the eventual result. This
design's sweeper is a **separate, second answer to "then who does?"** — it
does not need `runBackgroundContinuation`'s `timedOutStillRunning` branch to
change at all; the sweeper picks up exactly the runs that branch correctly
leaves as `"running"`.

**`TIMEOUT_MS` should survive, unchanged.** It is not a deadline on the
*workflow* — it is a deadline on how long *one HTTP-request-shaped
continuation* is worth keeping a live `AgentSession`+bash-executor+SSE-stream
open for, on the bet that delivery is imminent. That bet is worth capping
regardless of whether a sweeper exists — the sweeper's existence is what
makes it *safe* to give up at 30 minutes, because giving up no longer means
"nobody ever delivers this." Before this design, `TIMEOUT_MS` firing meant
"leave it running and hope a new prompt arrives" (`fetchStuckBackgroundRuns`
being prompt-gated); after this design, it means "leave it running, the
sweeper has this." The number 30 minutes itself is not re-litigated by this
design — it is a knob that could independently be tuned, but nothing here
depends on tuning it.

---

## 4. The leak

**Directly: unchanged by this design, and a backstop is still required.**
Neither the sweeper nor the durable-delivery primitive touches
`background-sessions.ts`'s retained-session lifetime for runs whose
continuation timed out — that Map only ever loses an entry via
`releaseBackgroundSession`, called from `background-continuation.ts`'s
non-timeout terminal branch and from `session-service.ts`'s new-prompt
supersede path. A run that hits `TIMEOUT_MS` and is picked up later by the
sweeper never has its retained session released by the sweeper in this
design as specified — the sweeper's own delivery path (§2) deliberately
constructs a *separate*, disposable `AgentSession` rather than reaching into
`background-sessions.ts`'s retained one, specifically to avoid touching an
object whose live state is unknown (see §1's citation of the
`sendCustomMessage`-on-disposed-session hazard — the retained session past
`TIMEOUT_MS` is in an unknown state, possibly still genuinely running its
bash executor for the workflow's own subagents, and the sweeper has no
business disposing something that might still be doing real work just
because *this* continuation gave up watching it).

So: **the sweeper should also call `releaseBackgroundSession(runId)` once it
has confirmed the run is terminal** (not merely timed out) — at that point
the retained session's bash executor genuinely has nothing left to do, and
disposing it is exactly correct, closing the gap 467dee7 left open (leaked
session, leaked executor, leaked SSE registry entry for a run that reached
terminal with the timeout branch declining to touch anything). This turns
the leak from "permanent, for any run that outlives `TIMEOUT_MS`" into
"bounded by the sweeper's own poll interval past actual completion" — a
60-second tail, not an indefinite one. It does **not** eliminate the case of
a run that times out and then simply *never* reaches terminal (a genuinely
stuck subagent, a workflow script in an infinite loop) — that retained
session is leaked for the life of the process regardless of any sweeper,
because nothing in this design (or in 467dee7) kills a run that will not
finish. That is a distinct, harder problem (upstream would need something
like a hard per-run kill switch) and is out of scope here — call it out
explicitly as **not solved** rather than imply the sweeper subsumes it.

---

## 5. Verifiability

| Claim | Provable by a test | Provable only by a real >30-minute run |
|---|---|---|
| Sweeper enumerates running runs across sessions and finds terminal transitions | Yes — fake the index/`readWorkflowRun`/`isRunTerminal` seams exactly as `background-continuation.test.ts` fakes its own dependencies; assert delivery + finalize called once per transition, not per tick (idempotency) | — |
| Sweeper does not double-deliver a run `background-continuation.ts`'s own non-timeout path already delivered | Yes — construct the race explicitly with fakes: run reaches terminal, the owning continuation's grace-period self-delivery fires first, `finalizeBackgroundRun` is called once; sweeper's next tick sees status already flipped by `upsertWorkflowRun`'s patch and must no-op. This needs a genuine idempotency guard (e.g. finalize only from `"running"`, which `finalizeBackgroundRun`'s existing `.eq("status","running")` on the Postgres update already gives — the disk-side `workflow-run-index.ts` write needs the equivalent check added, since `upsertWorkflowRun` today unconditionally overwrites) | — |
| The disposable-session delivery primitive appends a well-formed entry (parent linkage, session header) that the next `createSessionFile`/`readSessionEntries` reads correctly | Yes — this is exactly session-file/session-persistence territory already under test elsewhere in the repo; a new test constructs a session file, calls the primitive, and asserts `readSessionEntries` returns it in the live path | — |
| `resume()` refuses a completed/aborted run | Yes — already effectively proven by reading `workflow-manager.ts` source; a repo-side test would just pin the assumption against the installed package version, same pattern as the contract tests AGENTS.md describes for other pinned packages | — |
| The sweeper actually starts once per real process and survives 30+ minutes of real wall-clock time without leaking timers or double-starting under whatever Next.js does with `instrumentation.ts` in dev mode | — | Yes. This is a deployment-process fact, not a logic fact. |
| A workflow genuinely running longer than `TIMEOUT_MS` in the real deployed server has its result actually appear — durably, and in a still-open tab where possible — with no user prompt | — | Yes — this is the actual goal statement, and it is inescapably an end-to-end, real-process, real-wall-clock claim. Every one of its constituent decisions is unit-testable (above); their composition, in the real Next.js server, over a real half hour, is not. |
| Whether `instrumentation.ts`'s `register()` is ever called more than once per process in this repo's actual dev/prod setup (load-bearing for the sweeper's start-once guard) | — | Yes — this needs to be observed against the real running server, not assumed from Next.js documentation, per the note in §2. |

**Ceiling, stated plainly:** every piece of *logic* this design introduces —
enumeration, idempotent finalize, the transcript-append primitive, the
`resume()` refusal this design deliberately does not rely on — is unit
testable following the existing `background-continuation.test.ts` pattern of
structural fakes and module mocks. The claim that a user, having started a
workflow and closed their laptop, comes back forty minutes later to find the
result already sitting in their session with no action on their part — that
claim is only ever verified by actually doing it, once, against the real
server, and watching the clock.

---

## 6. Staging

Ordered so each stage is independently valuable, committable, and leaves
`tsc`/`lint`/`test` green on its own.

**Stage 0 — schema additions, no behavior change.** Add `agentCwd` to
`WorkflowRunRecord`/`upsertWorkflowRun`'s patch shape (defaulted/optional so
existing index files parse unchanged), add the metadata fields and a getter
to `background-sessions.ts`. Nothing calls the new fields yet. Fully
tested (existing `workflow-run-index.test.ts` extends trivially), zero
behavioral risk, reviewable in isolation.

**Stage 1 — unify delivery into one helper, no new trigger.** Extract
`session-service.ts`'s inline stuck-run delivery
(`session.sendCustomMessage` + `finishedRunMessage` + `finalizeBackgroundRun`)
into the `deliverToRestingSession`-shaped helper described in §2, and make
`session-service.ts` call it. Also make it handle `"failed"`/`"aborted"`,
not just `"completed"` — today's `if (runState.status !== "completed")
continue;` silently drops those (mentioned as a fix folded in here). This is
already user-visible value on its own: a workflow that failed while nobody
was watching currently never gets reported even on the next prompt; after
this stage it does. No sweeper yet — this is bounded to the existing
prompt-gated trigger, and is the **smallest stage that is independently,
concretely valuable**: it fixes a real gap in the current fallback with a
small, reviewable diff, and every consumer of the old inline code keeps
working through the new helper.

**Stage 2 — the sweeper itself, disabled by default or behind an env flag
during initial rollout.** Add `listAllRunningWorkflowRuns`, the
`background-run-sweeper.ts` module, and its `instrumentation.ts` wiring.
Have it call Stage 1's delivery helper and `releaseBackgroundSession`. Ship
it gated (e.g. an env var check inside the module, defaulting off) for one
deploy cycle so it can be watched under real traffic before it is trusted to
run unconditionally — this repo's own AGENTS.md instinct ("prefer a smaller
design that certainly works") argues for a manual kill switch on the very
first background-process addition of this kind, even though nothing else in
the codebase currently follows that pattern; call this out explicitly to the
owner as a recommendation, not an established convention, in the open
questions below.

**Stage 3 — turn the flag on, remove it once observed clean for some
period.** No code change beyond flipping the default (or deleting the flag
entirely) once Stage 2 has been watched running for real workflows crossing
`TIMEOUT_MS`.

Stage 1 alone already delivers real user-visible value (fixes the silent
`"failed"`/`"aborted"` drop, and gives every future caller one delivery
implementation instead of a second one waiting to be written). It should be
proposed and landed independently of whether the sweeper (Stage 2) is
approved at all.

---

## 7. Open questions for the repository owner

1. **Is Semla actually one long-lived Node process in production**, as
   `background-sessions.ts`'s docblock already asserts is required? This
   design's sweeper assumes exactly that (a `setInterval` started once from
   `instrumentation.ts`). If deployment is ever more than one replica, or
   restarts routinely (serverless-shaped hosting, rolling redeploys under
   load), the sweeper needs to be reasoned about per-instance (each instance
   sweeps only what it can see on its own local disk under
   `~/.pi/workflows/projects/*/runs/`) — worth confirming this is still true
   before staging any of this, since if it is not, `background-sessions.ts`'s
   existing warning already means far more today's design is being built on
   top of is silently broken.

2. **Should the sweeper's poll interval be configurable**, and if so where —
   an env var, alongside the existing `POLL_MS`/`DELIVERY_GRACE_MS`/
   `TIMEOUT_MS` constants in `background-continuation.ts`, or a genuinely
   separate constant in the new module? This design picked "~60s, hardcoded"
   as a starting guess with no measurement behind it.

3. **Does a `"failed"`/`"aborted"` run deserve the same delivery treatment as
   `"completed"`**, or should a failure be reported differently (e.g. a
   distinct message tone, or suppressed entirely if the failure was itself
   caused by something the sweeper should not narrate, such as the process
   having been killed mid-run and every "running" run on disk therefore
   looking abandoned rather than genuinely failed)? Stage 1 as designed
   treats them uniformly through `finishedRunMessage`; that may not be the
   right user-facing framing.

4. **Is the "construct a disposable `AgentSession` just to append one
   message" cost (full `createSessionFile`/`SessionManager.open`/
   `createAgentSession`/`bindExtensions` cycle) acceptable to pay per
   delivered run**, or does it justify building the raw-append primitive this
   design deliberately avoided in §1.d, accepting the tree-consistency risk
   that entails? This design chose the safer, heavier option; the owner may
   weigh the tradeoff differently, especially if delivered-late runs turn out
   to be common rather than rare.

5. **Should the sweeper's rollout gate (Stage 2's kill switch) exist at all**,
   or is that over-caution for a codebase whose other background jobs
   (`instrumentation.ts`'s existing startup work) ship ungated? Flagged as a
   recommendation in §6, not a decision this document is making unilaterally.

6. **What should happen to a run the sweeper finds still `"running"`
   indefinitely** — the case §4 explicitly leaves unsolved. Is a hard kill
   switch (something Semla, not upstream, would have to build against
   `WorkflowManager.stop()` or similar) worth designing next, or is "leaked
   until process restart" an acceptable known cost for a rare pathological
   case?
