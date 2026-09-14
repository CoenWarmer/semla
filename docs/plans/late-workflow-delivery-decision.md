# Decision: late workflow delivery

Synthesis of `docs/plans/late-workflow-delivery.md` (design), its adversarial
critique, and a simplest-alternative pass. Written for the repository owner
to approve, redirect, or reject.

---

## 1. The recommendation

**Ship the small fix now; do not commit to the sweeper yet.**

The design's own Stage 1 — relax `session-service.ts`'s stuck-run recovery
from `status === "completed"` to "any terminal status," thread the real
status through instead of hardcoding `"completed"`, and add the missing
`releaseBackgroundSession` call — is real, cited, and undisputed by all three
agents: `"failed"`/`"aborted"` background runs are silently dropped forever
today, and the fix is a few lines reusing an existing pattern. Ship that
first, paired with a lightweight visibility read (the simplest-alternative
agent's option (c)) so a user who reopens a session without typing anything
still learns a run finished, from the same `readWorkflowRun` call the
recovery path already makes. Neither of these needs the sweeper, neither is
controversial, and both are independently valuable starting today.

**The sweeper (design §1.b / Stage 2) is not rejected, but it is not ready to
build.** The critique found two unresolved correctness gaps in it (below),
and the simplest-alternative agent is right that its payoff — surviving a
process restart, not just a slow response — is real but narrower and rarer
than the framing implies, and rests on an unverified assumption (Semla is a
single long-lived process) that the design itself flags but does not close.
Do the cheap, undisputed fix now. Revisit the sweeper once the two gaps below
have concrete answers and someone has confirmed the single-process
assumption against the actual deployment, not the docblock's assertion of it.

The unbounded-watchdog option (design §1.a) is correctly rejected by the
design and is not reconsidered here: it makes today's leak permanent for no
compensating benefit, since the leak already survives `TIMEOUT_MS` firing
regardless of whether the ceiling is raised.

---

## 2. The mechanism (as designed, pending the gaps in §4)

**Trigger:** a process-level sweeper, started once from `instrumentation.ts`,
polling on the order of 60 seconds. Each tick enumerates every run any
session's index currently marks `"running"` (a new cross-session function on
`workflow-run-index.ts`), reads each run file off disk, and checks whether
its status has become terminal.

**Delivery:** on a transition to terminal, the sweeper writes the result
durably by constructing a *disposable* `AgentSession` for that session purely
to call `sendCustomMessage(..., { triggerTurn: false })` and dispose it — the
same construct→send→dispose sequence `session-service.ts` already runs at
the top of every prompt, reused for a one-message append. This is the design's
deliberate choice over a raw file/row append: this codebase has no
tree-consistency-safe raw-append primitive, and building one risks a
transcript entry whose parent linkage no longer matches what `SessionManager`
expects.

**Opportunistic live turn:** only if a retained `AgentSession` for that run
still happens to exist (checked via a new getter on `background-sessions.ts`,
which today is write/delete-only), the sweeper also pushes onto the still-open
SSE stream and starts a real report turn, the way
`background-continuation.ts`'s own self-delivery already does. Otherwise: a
durable message, visible next time the session is opened, no new turn.

**Cleanup:** the sweeper also calls `releaseBackgroundSession(runId)` once a
run is confirmed terminal, closing 467dee7's leftover leak from "permanent
past `TIMEOUT_MS`" to "a ~60s tail past actual completion."

---

## 3. Does it actually fix the complaint?

State this plainly, because it is the load-bearing honesty check.

**Does the user get an unprompted new assistant turn?** Only conditionally,
and the condition is rare in the scenario the task describes:

- **Server process never restarted, and a live `AgentSession` for that
  session happens to still be retained** (e.g. another prompt kept it alive)
  → yes, a real new turn, pushed to an open tab if one is open.
- **Server process never restarted, no retained session** (the common case
  once 30+ minutes have passed with nothing else happening in that session)
  → no new turn. A message is appended, durably, visible the next time the
  session is opened or reloaded. The user has to *look*, not *ask* — that is
  a real reduction from "reports back without me requesting" if that phrase
  is read as "produces a turn with no action from me at all."
- **Server process restarted or crashed in between** (a redeploy) → the
  sweeper itself is gone (it was a `setInterval` in the dead process), and
  nothing delivers anything until a *new* process starts its own sweeper and
  finds the run file still sitting there terminal. Stage 1's prompt-gated
  recovery is the only thing that currently reaches this case at all, and
  only once the user sends a new prompt.

**None of the three designs produce a guaranteed unprompted new turn to a
closed browser tab across a process restart.** That would require a push
channel Semla does not have, or riding upstream's `pi.sendMessage`/reload
handoff machinery, which the design correctly rules out (`resume()` refuses
on a completed/aborted run — confirmed by the critique against source). Say
this to the owner directly: **the sweeper turns "the result is lost until
someone asks" into "the result is sitting there durably, and sometimes
appears live" — it does not turn it into "the agent proactively reports to
you no matter what."**

---

## 4. Disagreements between the three agents

**Design vs. critique — is the mechanism's idempotency actually sound?**
The design's §5 verifiability table names the missing guard on
`upsertWorkflowRun` (disk-side writes unconditionally overwrite, no
`status === "running"` check unlike the Postgres side's `.eq("status",
"running")`) but treats it as a test-table footnote. The critique calls this
a blocking gap: without it, promoted to a concrete Stage 0/1 deliverable,
an implementer can ship the sweeper without the very check its own
idempotency argument depends on. **Verdict: the critique is right and the
design under-weights this.** It must be a named file-by-file change, not a
table aside.

**Design vs. critique — is check-then-act race-free?** The design assumes
the sweeper's next tick will see a status the owning continuation's
self-delivery already flipped, and no-op. The critique points out this is a
classic two-actor check-then-act race (separate timers, no atomic
claim/compare-and-swap), and that even with the `upsertWorkflowRun` guard
fixed, a genuine race window remains unless a distinct "delivered" marker
(not just "status") is added. **Verdict: the critique is right; the design's
race-freedom claim is asserted, not shown.** This is a Stage 2 blocker, not
a Stage 0/1 one — it does not affect the recommended first commit.

**Design vs. simplest-alternative — how much does the sweeper actually buy
over the cheap fix?** The design frames the sweeper as *the* answer to
"noticed independent of any request." The simplest-alternative agent agrees
this is the sweeper's genuine, unique value (surviving what the per-request
watchdog structurally cannot) but argues the design's framing overstates how
much of the *stated goal* — proactive delivery, no laptop-reopening required
— the sweeper actually closes, since delivery is still "next time someone
looks," identical in kind (if not in trigger) to what Stage 1 alone already
gives for the common case. **Verdict: not a factual disagreement — both are
correct on their own terms. The disagreement is about framing/priority, and
the simplest-alternative agent's sequencing (ship the cheap correctness fix
first, independent of whether the sweeper is ever approved) is the one this
document adopts.**

**Unresolved by any of the three: is Semla actually one long-lived process
in production?** The design flags this as open question 1 and the critique
independently flags it as unverified. Nobody in this task has confirmed it
against the real deployment; `background-sessions.ts`'s docblock asserts the
requirement, it does not prove the environment satisfies it. This gates
whether the sweeper is even a coherent design, not just whether it's
race-free.

---

## 5. What would change, file by file

**Now (Stage 1, recommended):**

- **`session-service.ts`** — relax `fetchStuckBackgroundRuns`'s recovery
  loop from `status !== "completed"` to `!isRunTerminal(runState)` (already
  imported elsewhere), thread the real status through
  `finishedRunMessage`/`finalizeBackgroundRun` instead of hardcoding
  `"completed"`, and add the missing `releaseBackgroundSession(run_id)` call
  that today's recovery loop never makes.
- A lightweight session-open visibility read (new or extended route) that
  calls the same `readWorkflowRun`/`listRunningWorkflowRuns` machinery
  eagerly on session open, not gated on a new prompt, and surfaces a banner
  ("this run is still in progress / finished with status X, last updated at
  Y") rather than requiring a delivered chat turn.

**Later, only after the open questions in §7 (and the two idempotency gaps
in §4) are resolved:**

- **`background-sessions.ts`** — add a getter and per-entry metadata
  (`semlaSessionId`, `agentCwd`); currently write/delete-only.
- **`workflow-run-index.ts`** — add a cross-session `listAllRunningWorkflowRuns`
  and an `agentCwd` field on `WorkflowRunRecord`; add the `status ===
  "running"` guard to `upsertWorkflowRun`'s write path (promoted from the
  design's test-table footnote to a required change, per the critique).
  Also needs a distinct delivered-once marker or equivalent CAS semantics to
  close the check-then-act race the critique identified — not fully
  specified yet by any of the three inputs.
- **New module `background-run-sweeper.ts`** — the sweeper itself, one
  `setInterval` from `instrumentation.ts`, gated behind a kill switch for at
  least one deploy cycle.
- **A durable-delivery helper** unifying with Stage 1's already-shipped
  helper, so the sweeper and the prompt-gated recovery path converge on one
  implementation.
- **`instrumentation.ts`** — wire the sweeper's startup call; verify
  empirically (not assume) whether `register()` can run more than once per
  process in this repo's actual dev/prod setup before relying on a
  module-level "started once" guard.

**Unchanged, and should stay unchanged:** `TIMEOUT_MS` and the rest of
`background-continuation.ts`'s existing watchdog shape. It is a cap on one
request's willingness to wait, not a workflow deadline; nothing here argues
for retuning it.

---

## 6. Verifiability

**Provable by test now (Stage 1):** the relaxed status check, the threaded
status value, the added `releaseBackgroundSession` call, and the visibility
read's banner logic — all unit-testable against existing fakes, no new
infrastructure.

**Provable by test later (if the sweeper proceeds):** run enumeration across
sessions, idempotent finalize *once the CAS/delivered-marker gap is closed*,
the disposable-session append producing a well-formed, correctly-linked
transcript entry, and `resume()`'s refusal on a completed/aborted run (this
last one is already effectively proven by reading source; a repo-side test
would just pin it against the installed package version).

**Provable only by a live run, full stop:** whether a workflow genuinely
running past `TIMEOUT_MS` has its result actually appear, durably, in a real
deployed server, over real wall-clock time — the actual goal statement, and
inescapably an end-to-end claim. Also only provable live: whether
`instrumentation.ts`'s `register()` is ever called more than once per
process in this repo's real dev/prod setup, which the sweeper's start-once
guard depends on and which is currently asserted, not observed, by the
design (the critique specifically flags the "Next.js's own history of..."
claim as unsupported by anything in this repository).

---

## 7. Staged plan

**Stage 0 (this week): ship the cheap fix.** `session-service.ts`'s
recovery relaxation + `releaseBackgroundSession` call + the visibility
banner. No sweeper, no schema change, no new module. Independently valuable
regardless of what happens to the rest of this document.

**Stage 1 (only if the sweeper is approved): schema-only.** Add `agentCwd`
to `WorkflowRunRecord`, add the guard to `upsertWorkflowRun`, add metadata +
getter to `background-sessions.ts`. No behavior change, fully tested.

**Stage 2 (only if the sweeper is approved, and only after Stage 1's guard
is confirmed to close the race with a real delivered-marker, not just a
status check): the sweeper itself, gated behind a kill switch, disabled by
default for one deploy cycle.**

**Stage 3: flip the gate on**, once Stage 2 has been observed clean against
real workflows crossing `TIMEOUT_MS`.

---

## 8. Open questions the owner must decide

1. Is Semla actually guaranteed to run as one long-lived process in
   production? The sweeper's entire design assumes this; nobody has
   confirmed it against the real deployment.
2. Is the literal goal "an unprompted new assistant turn," or is "a durable
   message the user sees next time they look" an acceptable reduction of it?
   Say yes or no explicitly — the sweeper, as designed, only delivers the
   former opportunistically.
3. Is the cost of a disposable `AgentSession` per delivered run (full
   `createSessionFile`/`SessionManager.open`/`createAgentSession`/
   `bindExtensions` cycle) acceptable, or is it worth building the riskier
   raw-append primitive the design deliberately avoided?
4. Should the sweeper's rollout be gated behind a manual kill switch (no
   precedent elsewhere in the codebase), or is that over-caution?
5. What should happen to a run that never reaches terminal at all (a
   genuinely stuck subagent)? Explicitly out of scope for both the design
   and this document — flagged, not solved.
6. Does a `"failed"`/`"aborted"` run deserve identical delivery treatment to
   `"completed"`, or a different tone/suppression? Stage 0 as recommended
   treats them uniformly.
